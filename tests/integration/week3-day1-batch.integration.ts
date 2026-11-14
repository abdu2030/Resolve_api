import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPrismaClient, type ResolvePrismaClient } from '@resolve/database';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import type { ResolveApplication } from '../../apps/api/src/application.js';
import { generateApiKey } from '../../apps/api/src/auth/api-key.js';
import type { createWorker } from '../../apps/worker/src/worker.js';

describe('Week 3 batch HTTP and worker', () => {
  const schema = `resolve_batch_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  url.searchParams.delete('schema');
  const db = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const saved = { ...process.env };
  let ownsSchema = false;
  let app: ResolveApplication | undefined;
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let prisma: ResolvePrismaClient;
  let server: Server;
  let tenantId: string;
  let token: string;
  let otherToken: string;
  let readToken: string;
  let writeToken: string;
  let queuedJob: string;

  beforeAll(async () => {
    await db.connect();
    await db.query(`CREATE SCHEMA "${schema}"`);
    ownsSchema = true;
    await db.query(`SET search_path TO "${schema}"`);
    const root = resolve('packages/database/prisma/migrations');
    for (const directory of (await readdir(root)).filter((name) => /^\d/.test(name)).sort()) {
      await db.query(await readFile(resolve(root, directory, 'migration.sql'), 'utf8'));
    }
    url.searchParams.set('schema', schema);
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      NODE_ENV: 'test',
      API_PORT: '3000',
      REDIS_HOST: process.env.TEST_REDIS_HOST ?? 'localhost',
      REDIS_PORT: process.env.TEST_REDIS_PORT ?? '6379',
      BATCH_QUEUE_PREFIX: schema,
      REQUEST_BODY_LIMIT: '1mb',
    });
    prisma = createPrismaClient(url.toString());
    tenantId = (await prisma.tenant.create({ data: { name: 'Batch tenant' } })).id;
    const other = (await prisma.tenant.create({ data: { name: 'Other tenant' } })).id;
    await prisma.sourceSystem.createMany({
      data: [
        { tenantId, name: 'crm', type: 'api' },
        { tenantId, name: 'billing', type: 'api' },
        { tenantId: other, name: 'foreign', type: 'api' },
      ],
    });
    token = await key(tenantId, ['records:write', 'jobs:read']);
    otherToken = await key(other, ['records:write', 'jobs:read']);
    readToken = await key(tenantId, ['jobs:read']);
    writeToken = await key(tenantId, ['records:write']);
    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    try {
      await worker?.close();
      if (worker) {
        const redis = new Redis({
          host: process.env.REDIS_HOST!,
          port: Number(process.env.REDIS_PORT!),
          maxRetriesPerRequest: 1,
        });
        try {
          const keys = await redis.keys(`${schema}:batch-resolution:*`);
          if (keys.length) await redis.del(...keys);
        } finally {
          redis.disconnect();
        }
      }
      await app?.close();
      await prisma?.$disconnect();
      if (ownsSchema) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await db.end();
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });

  async function key(owner: string, scopes: string[]): Promise<string> {
    const key = generateApiKey('test');
    await prisma.apiKey.create({
      data: { name: 'Batch tests', tenantId: owner, prefix: key.prefix, keyHash: key.hash, scopes },
    });
    return key.plaintext;
  }

  const records = [
    {
      source: 'crm',
      external_id: 'crm-1',
      entity_type: 'person',
      data: { name: '  Synthetic Person  ', email: 'batch@example.com', phone: '+251911987654' },
    },
    {
      source: 'billing',
      external_id: 'billing-1',
      entity_type: 'person',
      data: { name: 'Synthetic Person', email: 'batch@EXAMPLE.COM', phone: '+251911987654' },
    },
  ];

  function submit(
    body: object,
    idempotencyKey: string | null = 'initial',
    auth = token,
  ): request.Test {
    const post = request(server).post('/v1/records/batch').auth(auth, { type: 'bearer' });
    if (idempotencyKey !== null) post.set('Idempotency-Key', idempotencyKey);
    return post.send(body);
  }

  function status(id: string, auth = token): request.Test {
    return request(server).get(`/v1/jobs/${id}`).auth(auth, { type: 'bearer' });
  }

  async function waitForJob(id: string): Promise<unknown> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await status(id).expect(200);
      if (['SUCCEEDED', 'FAILED'].includes((response.body as { status: string }).status)) {
        return response.body as unknown;
      }
      await delay(100);
    }
    throw new Error('Batch did not reach a terminal state');
  }

  it('durably accepts and replays an authenticated batch before a worker is running', async () => {
    const created = await submit({ records }).expect(202);
    queuedJob = (created.body as { job_id: string }).job_id;
    expect(created.body).toEqual({ job_id: queuedJob, status: 'QUEUED' });
    expect(created.headers.location).toBe(`/v1/jobs/${queuedJob}`);
    const replay = await submit({ records }).expect(202);
    expect(replay.body).toEqual(created.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    await submit({ records: records.slice(0, 1) }).expect(409);
    expect((await status(queuedJob).expect(200)).body).toMatchObject({
      status: 'QUEUED',
      total_records: 2,
      processed_records: 0,
      attempts: 0,
      results: [],
    });
    expect(await prisma.sourceRecord.count({ where: { tenantId } })).toBe(0);
  });

  it('requires the appropriate scopes and validates every item before acceptance', async () => {
    await request(server).post('/v1/records/batch').send({ records }).expect(401);
    await submit({ records }, 'read-only', readToken).expect(403);
    await submit({ records }, null).expect(400);
    await submit({ records: [] }, 'empty').expect(400);
    await submit({ records: Array.from({ length: 101 }, () => records[0]!) }, 'oversize').expect(
      400,
    );
    await submit({ records: [[records[0]]] }, 'nested-array').expect(400);
    await submit({ records: [{ ...records[0], data: [] }] }, 'array-data').expect(400);
    await submit(
      { records: [{ ...records[0], data: { name: 'X', unexpected: true } }] },
      'bad',
    ).expect(400);
    await submit({ records, tenant_id: randomUUID() }, 'unknown').expect(400);
    await submit({ records: [{ ...records[0], source: 'foreign' }] }, 'foreign').expect(404);
    await status('invalid').expect(400);
    await status(queuedJob, writeToken).expect(403);
    await status(queuedJob, otherToken).expect(404);
    await status(queuedJob, readToken).expect(200);
  });

  it('resolves in order through the existing resolver and preserves the submitted raw data', async () => {
    const { createWorker } = await import('../../apps/worker/src/worker.js');
    worker = await createWorker();
    const response = await waitForJob(queuedJob);
    const stored = await prisma.sourceRecord.findMany({ where: { tenantId } });
    expect(stored).toHaveLength(2);
    expect(stored.find((item) => item.externalId === 'crm-1')?.rawPayload).toEqual(
      records[0]!.data,
    );
    expect(response).toMatchObject({
      status: 'SUCCEEDED',
      total_records: 2,
      processed_records: 2,
      succeeded_records: 2,
      failed_records: 0,
      attempts: 1,
      results: [
        { index: 0, result: { decision: 'NO_MATCH' }, error: null },
        { index: 1, result: { decision: 'AUTO_MATCH' }, error: null },
      ],
    });
    expect(await prisma.entity.count({ where: { tenantId } })).toBe(1);
  });

  it('retries transient failures from the first unfinished item', async () => {
    await db.query(`
      CREATE SEQUENCE batch_retry_probe;
      CREATE FUNCTION fail_batch_record() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
      BEGIN
        IF NEW.external_id = 'retry-2' AND nextval('batch_retry_probe') = 1 THEN
          RAISE EXCEPTION 'Synthetic transient database failure';
        END IF;
        IF NEW.external_id = 'always-fails' THEN
          RAISE EXCEPTION 'Synthetic persistent database failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER batch_retry_test BEFORE INSERT ON source_records
      FOR EACH ROW EXECUTE FUNCTION fail_batch_record();
    `);
    const created = await submit(
      {
        records: records.map((record, index) => ({
          ...record,
          external_id: `retry-${index + 1}`,
        })),
      },
      'retry',
    ).expect(202);
    expect(await waitForJob((created.body as { job_id: string }).job_id)).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
      processed_records: 2,
      failed_records: 0,
      results: [
        { result: { operation: 'CREATED', version: 1 } },
        { result: { operation: 'CREATED', version: 1 } },
      ],
    });
    const rows = await prisma.sourceRecord.findMany({
      where: { tenantId, externalId: { in: ['retry-1', 'retry-2'] } },
      include: { _count: { select: { versions: true } } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row._count.versions === 1)).toBe(true);

    const failed = await submit(
      {
        records: [
          { ...records[0], external_id: 'before-failure' },
          { ...records[1], external_id: 'always-fails' },
        ],
      },
      'exhausted',
    ).expect(202);
    expect(await waitForJob((failed.body as { job_id: string }).job_id)).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      processed_records: 1,
      failed_records: 0,
      error: { code: 'BATCH_RETRIES_EXHAUSTED' },
      results: [{ index: 0 }],
    });
  });

  it('records a permanent item conflict and continues with later items', async () => {
    const created = await submit(
      {
        records: [
          { ...records[0], entity_type: 'company', data: { name: 'Conflict Ltd' } },
          { ...records[1], external_id: 'after-conflict' },
        ],
      },
      'conflict',
    ).expect(202);
    expect(await waitForJob((created.body as { job_id: string }).job_id)).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      processed_records: 2,
      succeeded_records: 1,
      failed_records: 1,
      error: { code: 'BATCH_RECORDS_FAILED' },
      results: [
        { index: 0, result: null, error: { code: 'ENTITY_TYPE_CONFLICT' } },
        { index: 1, result: { operation: 'CREATED' }, error: null },
      ],
    });
  });
});
