import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
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
import type { AcceptedBatchDto, BatchJobDto } from '../../apps/api/src/jobs/batch-job.dto.js';
import type { createWorker } from '../../apps/worker/src/worker.js';

// BullMQ checks every 30 seconds. The previous worker's locks can delay the
// scans that mark the job as stalled and put it back on the queue.
const stalledJobRecoveryTimeoutMs = 130_000;

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
  const childWorkers = new Set<ChildProcess>();

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
      await Promise.all([...childWorkers].map(stopWorker));
      if (ownsSchema) {
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

  async function waitForJob(id: string, timeoutMs = 20_000): Promise<BatchJobDto> {
    const deadline = Date.now() + timeoutMs;
    let current: BatchJobDto | undefined;
    while (Date.now() < deadline) {
      const response = await status(id).expect(200);
      current = response.body as BatchJobDto;
      if (current.status === 'SUCCEEDED' || current.status === 'FAILED') return current;
      await delay(100);
    }
    throw new Error(
      `Batch timed out in ${current?.status} with ${current?.processed_records} processed`,
    );
  }

  async function withAdvisoryLock<T>(identity: string, run: () => Promise<T>): Promise<T> {
    await db.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [identity]);
    try {
      return await run();
    } finally {
      await db.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [identity]);
    }
  }

  async function waitForLockWaiters(
    identity: string,
    minimum: number,
    timeoutMs = 3500,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await db.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_locks
         WHERE locktype = 'advisory' AND mode = 'ExclusiveLock' AND NOT granted
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND classid::bigint = ((hashtextextended($1, 0) >> 32) & 4294967295)
           AND objid::bigint = (hashtextextended($1, 0) & 4294967295) AND objsubid = 1`,
        [identity],
      );
      if (rows[0]!.waiting >= minimum) return;
      await delay(15);
    }
    throw new Error(`Expected at least ${minimum} transactions waiting on the advisory lock`);
  }

  async function recordLock(externalId: string): Promise<string> {
    const source = await prisma.sourceSystem.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name: 'crm' } },
    });
    return `record:${tenantId}:${source.id}:${externalId}`;
  }

  async function startChildWorker(): Promise<{ child: ChildProcess; logs: () => string }> {
    const child = spawn(process.execPath, [resolve('apps/worker/dist/main.js')], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    childWorkers.add(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8').on('data', (chunk: string) => {
        output = `${output}${chunk}`.slice(-4000);
      });
    }
    child.once('exit', () => childWorkers.delete(child));
    await once(child, 'spawn');
    return { child, logs: () => output };
  }

  async function stopWorker(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
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

  it('commits one job when identical batches and a conflicting payload contend for one key', async () => {
    const key = 'concurrent-batch';
    const identity = `idempotency:${tenantId}:${key}`;
    const record = { ...records[0]!, external_id: 'concurrent-batch' };
    const body = { records: [record] };
    const pending: Promise<request.Response>[] = [];
    try {
      await withAdvisoryLock(identity, async () => {
        pending.push(submit(body, key).then((response) => response));
        await waitForLockWaiters(identity, 1);
        pending.push(
          submit(body, key).then((response) => response),
          submit({ records: [{ ...record, data: { name: 'Different person' } }] }, key).then(
            (response) => response,
          ),
        );
        await waitForLockWaiters(identity, 3);
      });
      const [first, duplicate, conflict] = await Promise.all(pending);
      expect(first?.status).toBe(202);
      expect(duplicate?.status).toBe(202);
      expect(duplicate?.body).toEqual(first?.body);
      expect(duplicate?.headers['idempotency-replayed']).toBe('true');
      expect(conflict?.status).toBe(409);
      expect(conflict?.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
      const { job_id: id } = first!.body as AcceptedBatchDto;
      expect(await prisma.idempotencyRequest.count({ where: { tenantId, key } })).toBe(1);
      expect(
        await prisma.jobRecord.findMany({
          where: { tenantId, input: { path: ['external_id'], equals: record.external_id } },
          select: { jobId: true, position: true },
        }),
      ).toEqual([{ jobId: id, position: 0 }]);
      expect((await waitForJob(id)).attempts).toBe(1);
    } finally {
      await Promise.allSettled(pending);
    }
  });

  it('serializes the worker and a direct request for the same source identity', async () => {
    const record = {
      source: 'crm',
      external_id: 'shared-ingestion-lock',
      entity_type: 'person',
      data: { name: 'New Concurrent Person' },
    };
    const identity = await recordLock(record.external_id);
    let direct: Promise<request.Response> | undefined;
    try {
      const id = await withAdvisoryLock(identity, async () => {
        const accepted = await submit({ records: [record] }, 'race-http').expect(202);
        await waitForLockWaiters(identity, 1);
        direct = request(server)
          .post('/v1/records')
          .auth(token, { type: 'bearer' })
          .send(record)
          .then((response) => response);
        await waitForLockWaiters(identity, 2);
        return (accepted.body as AcceptedBatchDto).job_id;
      });
      const response = await direct;
      expect(response?.status).toBe(200);
      const batch = await waitForJob(id);
      expect(batch).toMatchObject({ status: 'SUCCEEDED', attempts: 1, processed_records: 1 });
      const result = batch.results[0]?.result;
      expect(result).toMatchObject({ operation: 'CREATED', version: 1 });
      expect(response?.body).toMatchObject({
        record_id: result?.record_id,
        entity_id: result?.entity_id,
        operation: 'UNCHANGED',
        version: 1,
      });
      const rows = await prisma.sourceRecord.findMany({
        where: { tenantId, externalId: record.external_id },
        include: { entityRecordLink: true, _count: { select: { versions: true } } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        _count: { versions: 1 },
        entityRecordLink: { entityId: result?.entity_id },
      });
      expect(
        await prisma.entityCanonicalVersion.count({
          where: { tenantId, triggerSourceRecordId: result!.record_id },
        }),
      ).toBe(1);
    } finally {
      await direct?.catch(() => undefined);
    }
  });

  async function recoverAfterWorkerCrash(): Promise<void> {
    await worker?.close();
    worker = undefined;
    const batch = [
      { ...records[0]!, external_id: 'crash-1' },
      { ...records[0]!, external_id: 'crash-2' },
    ];
    const identity = await recordLock(batch[1]!.external_id);
    const { id, partial } = await withAdvisoryLock(identity, async () => {
      const accepted = await submit({ records: batch }, 'crash-recovery').expect(202);
      const { job_id: id } = accepted.body as AcceptedBatchDto;
      const first = await startChildWorker();
      let partial: BatchJobDto['results'][number] | undefined;
      try {
        await waitForLockWaiters(identity, 1, 20_000);
        const response = await status(id).expect(200);
        const state = response.body as BatchJobDto;
        expect(state).toMatchObject({ status: 'RUNNING', processed_records: 1, attempts: 1 });
        const result = state.results[0];
        expect(result).toMatchObject({ index: 0, result: { operation: 'CREATED', version: 1 } });
        expect(
          await prisma.sourceRecord.count({ where: { tenantId, externalId: 'crash-2' } }),
        ).toBe(0);
        partial = result;
      } catch (cause) {
        throw new Error(`Could not interrupt the first worker\n${first.logs()}`, { cause });
      } finally {
        await stopWorker(first.child);
      }
      expect(first.child.signalCode).toBe('SIGKILL');
      return { id, partial };
    });
    const replacement = await startChildWorker();
    try {
      const recovered = await waitForJob(id, stalledJobRecoveryTimeoutMs);
      expect(recovered).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 2,
        processed_records: 2,
        failed_records: 0,
      });
      expect(recovered.results[0]).toEqual(partial);
      expect(recovered.results[1]).toMatchObject({
        index: 1,
        result: { operation: 'CREATED', version: 1 },
      });
      for (const { result } of recovered.results) {
        expect(
          await prisma.sourceRecordVersion.count({
            where: { tenantId, sourceRecordId: result!.record_id },
          }),
        ).toBe(1);
        expect(
          await prisma.entityRecordLink.count({
            where: { tenantId, sourceRecordId: result!.record_id },
          }),
        ).toBe(1);
      }
    } catch (cause) {
      throw new Error(`Could not recover the stalled job\n${replacement.logs()}`, { cause });
    } finally {
      await stopWorker(replacement.child);
    }
  }

  it(
    'recovers an active BullMQ job after killing the worker with one item committed',
    recoverAfterWorkerCrash,
    stalledJobRecoveryTimeoutMs + 30_000,
  );
});
