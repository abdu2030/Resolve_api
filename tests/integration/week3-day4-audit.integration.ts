import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import type {
  EntityOperationResult,
  RecordIngestionResult,
  ReviewDecisionResult,
} from '@resolve/contracts';
import { createPrismaClient, type ResolvePrismaClient } from '@resolve/database';
import { Client } from 'pg';
import request from 'supertest';
import type { ResolveApplication } from '../../apps/api/src/application.js';
import { generateApiKey } from '../../apps/api/src/auth/api-key.js';
import { WebhookTransport } from '../../apps/api/src/webhooks/webhook-transport.js';

interface AuditRow {
  id: string;
  tenant_id: string;
  actor_api_key_id: string | null;
  action: string;
  resource_id: string;
  data: Record<string, unknown>;
  created_at: Date;
}

describe('Week 3 Day 4 durable audit history', () => {
  const schema = 'resolve_audit_' + randomUUID().replaceAll('-', '');
  const url = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  url.searchParams.delete('schema');
  const db = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const savedEnv = { ...process.env };
  let ownsSchema = false;
  let prisma: ResolvePrismaClient;
  let app: ResolveApplication;
  let server: Server;
  let tenantId: string;
  let actorId: string;
  let token: string;

  beforeAll(async () => {
    await db.connect();
    await db.query(`CREATE SCHEMA "${schema}"`);
    ownsSchema = true;
    await db.query(`SET search_path TO "${schema}"`);
    const migrations = resolve('packages/database/prisma/migrations');
    for (const directory of (await readdir(migrations)).filter((name) => /^\d/.test(name)).sort()) {
      await db.query(await readFile(resolve(migrations, directory, 'migration.sql'), 'utf8'));
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
      WEBHOOK_ENCRYPTION_KEY: 'ab'.repeat(32),
    });
    prisma = createPrismaClient(url.toString());
    jest.spyOn(WebhookTransport.prototype, 'resolve').mockImplementation((destination) =>
      Promise.resolve({
        url: new URL(destination),
        addresses: [{ address: '93.184.215.14', family: 4 }],
      }),
    );
    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    tenantId = (await prisma.tenant.create({ data: { name: 'Audit integration' } })).id;
    const key = generateApiKey('test');
    token = key.plaintext;
    actorId = (
      await prisma.apiKey.create({
        data: {
          tenantId,
          name: 'Audit test actor',
          prefix: key.prefix,
          keyHash: key.hash,
          scopes: [
            'sources:write',
            'records:write',
            'reviews:write',
            'entities:merge',
            'entities:split',
            'webhooks:manage',
          ],
        },
      })
    ).id;
  });

  afterAll(async () => {
    try {
      await app?.close();
      await prisma?.$disconnect();
      if (ownsSchema) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await db.end();
      jest.restoreAllMocks();
      for (const name of Object.keys(process.env))
        if (!(name in savedEnv)) delete process.env[name];
      Object.assign(process.env, savedEnv);
    }
  });

  function post(path: string, input?: object, key?: string): request.Test {
    const call = request(server).post(`/v1${path}`).auth(token, { type: 'bearer' });
    if (input) call.send(input);
    if (key) call.set('Idempotency-Key', key);
    return call;
  }

  async function events(tenant = tenantId): Promise<AuditRow[]> {
    return (
      await db.query<AuditRow>(
        'SELECT * FROM audit_events WHERE tenant_id = $1 ORDER BY created_at, id',
        [tenant],
      )
    ).rows;
  }

  async function ingest(data: Record<string, unknown>): Promise<RecordIngestionResult> {
    const response = await post('/records', {
      source: 'crm',
      entity_type: 'person',
      external_id: randomUUID(),
      data,
    }).expect(201);
    return response.body as RecordIngestionResult;
  }

  async function createSourceFixture(): Promise<void> {
    await prisma.sourceSystem.create({ data: { tenantId, name: 'crm', type: 'api' } });
  }

  it('records the authenticated actor and source ID once for successful source registration', async () => {
    const payload = { name: 'private-source-name', type: 'private-source-type' };
    const source = await post('/sources', payload).expect(201);
    await post('/sources', payload).expect(200);
    await post('/sources', { ...payload, priority: 10 }).expect(409);
    await post('/sources', { ...payload, type: 'conflicting-type' }).expect(409);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: tenantId,
      actor_api_key_id: actorId,
      action: 'source.registered',
      resource_id: (source.body as { source_id: string }).source_id,
    });
    expect(rows[0]?.data).toEqual({});
    expect(rows[0]?.created_at).toBeInstanceOf(Date);
  });

  it('rolls back source creation if its audit event cannot be committed', async () => {
    await db.query(
      'ALTER TABLE audit_events ADD CONSTRAINT test_fail_audit_insert CHECK (false) NOT VALID',
    );
    try {
      await post('/sources', { name: 'rolled-back', type: 'api' }).expect(500);
    } finally {
      await db.query('ALTER TABLE audit_events DROP CONSTRAINT test_fail_audit_insert');
    }
    expect(await prisma.sourceSystem.count({ where: { tenantId } })).toBe(0);
    expect(await events()).toEqual([]);
  });

  it('rejects foreign and missing actors and prevents changes to existing audit rows', async () => {
    await post('/sources', { name: 'audit-constraints', type: 'api' }).expect(201);
    const rows = await events();
    expect(rows).toHaveLength(1);
    const audit = rows[0]!;
    const foreign = (await prisma.tenant.create({ data: { name: 'Foreign audit tenant' } })).id;
    const insert =
      `INSERT INTO audit_events (tenant_id, actor_api_key_id, action, resource_id)` +
      ` VALUES ($1, $2, 'source.registered', $3)`;
    await expect(db.query(insert, [foreign, actorId, randomUUID()])).rejects.toMatchObject({
      code: '23503',
    });
    await expect(db.query(insert, [tenantId, null, randomUUID()])).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      db.query('UPDATE audit_events SET data = $1 WHERE id = $2', ['{"changed": true}', audit.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.query('DELETE FROM audit_events WHERE id = $1', [audit.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('TRUNCATE audit_events')).rejects.toMatchObject({ code: '23514' });
    expect(await events()).toEqual(rows);
  });

  it('links a review audit event to persisted decision history without copying the reason', async () => {
    await createSourceFixture();
    const address = { city: 'Addis', country: 'ET' };
    await ingest({ name: 'Review Fixture', phone: '+251911223344', address });
    const incoming = await ingest({ name: 'Review Fixture', phone: '+251922223344', address });
    expect(incoming.decision).toBe('REVIEW');
    const review = await prisma.reviewCase.findUniqueOrThrow({
      where: { tenantId_sourceRecordId: { tenantId, sourceRecordId: incoming.record_id } },
    });
    const path = `/reviews/${review.id}/decision`;
    const payload = {
      decision: 'REJECT',
      reason: 'Private review reason with person@example.test',
      expected_source_version: 1,
      expected_candidate_version: 1,
    };
    const key = randomUUID();
    const result = await post(path, payload, key).expect(200);
    const decision = result.body as ReviewDecisionResult;
    await post(path, payload, key).expect('Idempotency-Replayed', 'true').expect(200);
    await post(path, payload, randomUUID()).expect(409);
    const rows = await events();
    expect(rows).toMatchObject([
      {
        actor_api_key_id: actorId,
        action: 'review.resolved',
        resource_id: review.id,
        data: { review_decision_id: decision.review_decision_id, decision: 'REJECT' },
      },
    ]);
    expect(rows[0]?.data).toEqual({
      review_decision_id: decision.review_decision_id,
      decision: 'REJECT',
    });
    expect(await prisma.reviewDecision.count({ where: { tenantId } })).toBe(1);
  });

  it('records a distinct audit event for merge, split, and merge reversal', async () => {
    await createSourceFixture();
    const source = await ingest({ name: 'Original Source' });
    const target = await ingest({ name: 'Original Target' });
    const reason = 'Private reason with person@example.test';
    const key = randomUUID();
    const mergePath = `/entities/${target.entity_id}/merge`;
    const mergeInput = {
      source_entity_id: source.entity_id,
      expected_source_version: 1,
      expected_target_version: 1,
      reason,
    };
    const merged = (await post(mergePath, mergeInput, key).expect(200))
      .body as EntityOperationResult;
    await post(mergePath, mergeInput, key).expect('Idempotency-Replayed', 'true').expect(200);
    const splitPath = `/entities/${target.entity_id}/split`;
    const reversed = (
      await post(
        splitPath,
        { merge_event_id: merged.operation_id, expected_version: 2, reason },
        randomUUID(),
      ).expect(200)
    ).body as EntityOperationResult;
    const secondMerge = (
      await post(
        mergePath,
        { ...mergeInput, expected_source_version: 3, expected_target_version: 3 },
        randomUUID(),
      ).expect(200)
    ).body as EntityOperationResult;
    const split = (
      await post(
        splitPath,
        { record_ids: [source.record_id], expected_version: 4, reason },
        randomUUID(),
      ).expect(201)
    ).body as EntityOperationResult;
    const rows = await events();
    expect(rows).toHaveLength(4);
    for (const [action, operation] of [
      ['entity.merged', merged],
      ['entity.merge_reversed', reversed],
      ['entity.merged', secondMerge],
      ['entity.split', split],
    ] as const) {
      const audit = rows.find((row) => row.data.operation_id === operation.operation_id);
      expect(audit).toMatchObject({
        actor_api_key_id: actorId,
        action,
        resource_id: target.entity_id,
      });
      expect(audit?.data).toEqual({
        operation_id: operation.operation_id,
        source_entity_id: operation.source_entity_id,
        target_entity_id: operation.target_entity_id,
      });
    }
    expect(await prisma.entityOperation.count({ where: { tenantId } })).toBe(4);
  });

  it('records endpoint registration and each successful replay without copying credentials', async () => {
    const endpointPath = '/webhook-endpoints';
    const input = {
      url: 'https://callback.example.test/private-path?token=callback-secret',
      events: ['record.resolved'],
      signing_secret: 'af'.repeat(32),
    };
    const registered = await post(endpointPath, input).expect(201);
    const { endpoint_id: endpointId } = registered.body as { endpoint_id: string };
    await post(endpointPath, input).expect(409);
    const event = await prisma.webhookEvent.create({
      data: { tenantId, type: 'record.resolved', data: {} },
    });
    const delivery = await prisma.webhookDelivery.create({
      data: { tenantId, endpointId, eventId: event.id, status: 'DELIVERED', attempts: 1 },
    });
    const path = `${endpointPath}/${endpointId.toUpperCase()}/deliveries/${event.id.toUpperCase()}/replay`;
    const key = randomUUID();
    await post(path, undefined, key).expect(202);
    await post(path, undefined, key).expect('Idempotency-Replayed', 'true').expect(202);
    await post(path, undefined, randomUUID()).expect(409);
    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.resource_id === endpointId)).toMatchObject({
      action: 'webhook_endpoint.registered',
      actor_api_key_id: actorId,
    });
    expect(rows.find((row) => row.resource_id === endpointId)?.data).toEqual({});
    const replay = rows.find((row) => row.resource_id === delivery.id);
    expect(replay).toMatchObject({
      action: 'webhook_delivery.replayed',
      actor_api_key_id: actorId,
    });
    expect(replay?.data).toEqual({ endpoint_id: endpointId, event_id: event.id });
  });

  it('records bootstrap with no API-key actor and identifies the new API key by ID', async () => {
    const name = 'Private bootstrap tenant name';
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/api/src/auth/bootstrap-api-key.ts',
        '--tenant-name',
        name,
        '--environment',
        'test',
      ],
      { env: process.env },
    );
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { name } });
    const key = await prisma.apiKey.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const rows = await events(tenant.id);
    expect(rows).toMatchObject([
      {
        tenant_id: tenant.id,
        actor_api_key_id: null,
        action: 'api_key.bootstrapped',
        resource_id: key.id,
      },
    ]);
    expect(rows[0]?.data).toEqual({});
  });
});
