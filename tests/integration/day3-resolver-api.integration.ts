import type { Server } from 'node:http';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { type ResolvePrismaClient } from '@resolve/database';
import { jest } from '@jest/globals';
import { Client } from 'pg';
import request from 'supertest';

import type { ResolveApplication } from '../../apps/api/src/application.js';
import { hashApiKey } from '../../apps/api/src/auth/api-key.js';
import { PRISMA_CLIENT } from '../../apps/api/src/infrastructure/infrastructure.tokens.js';
import { ResolutionService } from '../../apps/api/src/resolution/resolution.service.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const prismaCli = resolve(repositoryRoot, 'node_modules/prisma/build/index.js');
const prismaConfig = resolve(repositoryRoot, 'prisma.config.ts');
const tenantAToken = 'rslv_test_700000000001.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const tenantBToken = 'rslv_test_700000000002.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const originalEnvironment = {
  BLOCKING_MAX_CANDIDATES: process.env.BLOCKING_MAX_CANDIDATES,
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  API_PORT: process.env.API_PORT,
  REDIS_HOST: process.env.REDIS_HOST,
  REDIS_PORT: process.env.REDIS_PORT,
  REQUEST_BODY_LIMIT: process.env.REQUEST_BODY_LIMIT,
};

interface RecordResponseBody {
  record_id: string;
  entity_id: string;
  decision: 'AUTO_MATCH' | 'REVIEW' | 'NO_MATCH';
  confidence: number;
  matched_against?: string;
  explanation: {
    candidate_count: number;
    features: Record<string, unknown>;
    contradictions: Array<{ code: string; severity: string }>;
  };
  algorithm_version: string;
  operation: 'CREATED' | 'UPDATED' | 'UNCHANGED';
}

describe('Day 3 resolver API pipeline', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = `resolve_day3_api_${process.pid}_${Date.now()}`;
  const adminUrl = databaseUrlForSchema(baseDatabaseUrl);
  const isolatedUrl = databaseUrlForSchema(baseDatabaseUrl, schemaName);

  let admin: Client;
  let database: Client;
  let app: ResolveApplication;
  let prisma: ResolvePrismaClient;
  let resolution: ResolutionService;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query('CREATE SCHEMA ' + quoteIdentifier(schemaName));
    await execFileAsync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--config', prismaConfig],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DATABASE_URL: isolatedUrl },
        maxBuffer: 1024 * 1024,
      },
    );

    process.env.BLOCKING_MAX_CANDIDATES = '100';
    process.env.DATABASE_URL = isolatedUrl;
    process.env.NODE_ENV = 'test';
    process.env.API_PORT = '3000';
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.REQUEST_BODY_LIMIT = '1mb';

    database = new Client({ connectionString: adminUrl });
    await database.connect();
    await database.query('SET search_path TO ' + quoteIdentifier(schemaName));
    tenantA = await insertTenant(database, 'Resolver API Tenant A');
    tenantB = await insertTenant(database, 'Resolver API Tenant B');
    await insertApiKey(database, tenantA, tenantAToken);
    await insertApiKey(database, tenantB, tenantBToken);
    await insertSource(database, tenantA, 'resolver');
    await insertSource(database, tenantB, 'resolver');

    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    prisma = app.get(PRISMA_CLIENT);
    resolution = app.get(ResolutionService);
  });

  afterAll(async () => {
    await app?.close();
    await database?.end();
    if (admin) {
      await admin.query('DROP SCHEMA IF EXISTS ' + quoteIdentifier(schemaName) + ' CASCADE');
      await admin.end();
    }
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('runs ingestion through no-match and automatic-match outcomes', async () => {
    const first = await ingest(app, tenantAToken, {
      source: 'resolver',
      external_id: 'pipeline-first',
      entity_type: 'person',
      data: {
        name: 'Pipeline Person',
        email: 'pipeline@example.com',
        phone: '+251911100001',
      },
    }).expect(201);
    const firstBody = first.body as RecordResponseBody;
    expect(typeof firstBody.record_id).toBe('string');
    expect(typeof firstBody.entity_id).toBe('string');
    expect(firstBody).toMatchObject({
      decision: 'NO_MATCH',
      confidence: 0,
      explanation: { candidate_count: 0, features: {}, contradictions: [] },
      algorithm_version: 'rules-0.1.0',
      operation: 'CREATED',
    });
    expect(firstBody).not.toHaveProperty('matched_against');

    const second = await ingest(app, tenantAToken, {
      source: 'resolver',
      external_id: 'pipeline-second',
      entity_type: 'person',
      data: {
        name: 'Pipeline Person',
        email: 'pipeline@example.com',
        phone: '+251911100001',
      },
    }).expect(201);
    const secondBody = second.body as RecordResponseBody;
    expect(secondBody).toMatchObject({
      entity_id: firstBody.entity_id,
      matched_against: firstBody.entity_id,
      decision: 'AUTO_MATCH',
      confidence: 1,
      explanation: {
        candidate_count: 1,
        features: { email_exact: true, phone_exact: true },
        contradictions: [],
      },
      algorithm_version: 'rules-0.1.0',
    });

    const beforeReplay = await resolutionCounts(prisma, tenantA);
    const unchanged = await ingest(app, tenantAToken, {
      source: 'resolver',
      external_id: 'pipeline-second',
      entity_type: 'person',
      data: {
        name: 'Pipeline Person',
        email: 'pipeline@example.com',
        phone: '+251911100001',
      },
    }).expect(200);
    expect(unchanged.body).toMatchObject({
      entity_id: secondBody.entity_id,
      decision: secondBody.decision,
      confidence: secondBody.confidence,
      explanation: secondBody.explanation,
      algorithm_version: secondBody.algorithm_version,
      operation: 'UNCHANGED',
    });
    expect(await resolutionCounts(prisma, tenantA)).toEqual(beforeReplay);
  });

  it('creates a review case without linking the review record', async () => {
    const base = await ingest(app, tenantAToken, {
      source: 'resolver',
      external_id: 'review-base',
      entity_type: 'person',
      data: {
        name: 'API Review Person',
        phone: '+251911200001',
        address: { city: 'Addis Ababa', country: 'ET' },
      },
    }).expect(201);
    const baseBody = base.body as RecordResponseBody;

    const review = await ingest(app, tenantAToken, {
      source: 'resolver',
      external_id: 'review-incoming',
      entity_type: 'person',
      data: {
        name: 'API Review Person',
        phone: '+251911200002',
        address: { city: 'Addis Ababa', country: 'ET' },
      },
    }).expect(201);
    const reviewBody = review.body as RecordResponseBody;

    expect(reviewBody).toMatchObject({
      entity_id: baseBody.entity_id,
      matched_against: baseBody.entity_id,
      decision: 'REVIEW',
      confidence: 0.85,
      explanation: {
        candidate_count: 1,
        contradictions: [{ code: 'PHONE_CONFLICT', severity: 'warning' }],
      },
    });
    expect(
      await prisma.entityRecordLink.count({
        where: { tenantId: tenantA, sourceRecordId: reviewBody.record_id },
      }),
    ).toBe(0);
    expect(
      await prisma.reviewCase.count({
        where: { tenantId: tenantA, sourceRecordId: reviewBody.record_id },
      }),
    ).toBe(1);
  });

  it('replays an idempotent response without duplicate resolution effects', async () => {
    const payload = {
      source: 'resolver',
      external_id: 'idempotent-resolution',
      entity_type: 'person',
      data: { email: 'idempotent-resolution@example.com' },
    };
    const first = await ingest(app, tenantAToken, payload, 'day3-idempotency').expect(201);
    const beforeReplay = await resolutionCounts(prisma, tenantA);
    const replay = await ingest(app, tenantAToken, payload, 'day3-idempotency').expect(201);

    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(await resolutionCounts(prisma, tenantA)).toEqual(beforeReplay);
  });

  it('does not match records across tenants', async () => {
    const first = await ingest(app, tenantAToken, {
      source: 'resolver',
      external_id: 'tenant-boundary-a',
      entity_type: 'person',
      data: { email: 'tenant-boundary@example.com' },
    }).expect(201);
    const isolated = await ingest(app, tenantBToken, {
      source: 'resolver',
      external_id: 'tenant-boundary-b',
      entity_type: 'person',
      data: { email: 'tenant-boundary@example.com' },
    }).expect(201);

    expect(first.body).toMatchObject({ decision: 'NO_MATCH' });
    expect(isolated.body).toMatchObject({ decision: 'NO_MATCH', confidence: 0 });
    expect((isolated.body as RecordResponseBody).entity_id).not.toBe(
      (first.body as RecordResponseBody).entity_id,
    );
  });

  it('rolls back record storage when resolution fails', async () => {
    await ingest(app, tenantAToken, {
      source: 'resolver',
      external_id: 'rollback-base',
      entity_type: 'person',
      data: { email: 'rollback@example.com' },
    }).expect(201);
    const beforeFailure = await resolutionCounts(prisma, tenantA);
    const resolve = resolution.resolve.bind(resolution);
    jest
      .spyOn(resolution, 'resolve')
      .mockImplementationOnce(async (transaction, tenantId, sourceRecordId) => {
        await resolve(transaction, tenantId, sourceRecordId);
        throw new Error('forced resolver failure');
      });

    await ingest(
      app,
      tenantAToken,
      {
        source: 'resolver',
        external_id: 'rollback-resolution',
        entity_type: 'person',
        data: { email: 'rollback@example.com' },
      },
      'rollback-resolution-key',
    ).expect(500);

    expect(await resolutionCounts(prisma, tenantA)).toEqual(beforeFailure);
  });
});

function ingest(
  app: ResolveApplication,
  token: string,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): request.Test {
  const operation = request(app.getHttpServer() as Server)
    .post('/v1/records')
    .set('Authorization', 'Bearer ' + token);
  if (idempotencyKey) operation.set('Idempotency-Key', idempotencyKey);
  return operation.send(payload);
}

async function resolutionCounts(
  prisma: ResolvePrismaClient,
  tenantId: string,
): Promise<Record<string, number>> {
  const [records, versions, entities, links, features, reviews, idempotencyRequests] =
    await Promise.all([
      prisma.sourceRecord.count({ where: { tenantId } }),
      prisma.sourceRecordVersion.count({ where: { tenantId } }),
      prisma.entity.count({ where: { tenantId } }),
      prisma.entityRecordLink.count({ where: { tenantId } }),
      prisma.matchFeature.count({ where: { tenantId } }),
      prisma.reviewCase.count({ where: { tenantId } }),
      prisma.idempotencyRequest.count({ where: { tenantId } }),
    ]);
  return {
    records,
    versions,
    entities,
    links,
    features,
    reviews,
    idempotencyRequests,
  };
}

function databaseUrlForSchema(databaseUrl: string, schema?: string): string {
  const url = new URL(databaseUrl);
  if (schema) url.searchParams.set('schema', schema);
  else url.searchParams.delete('schema');
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return '"' + identifier.replaceAll('"', '""') + '"';
}

async function insertTenant(database: Client, name: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [name],
  );
  return result.rows[0]!.id;
}

async function insertApiKey(database: Client, tenantId: string, token: string): Promise<void> {
  await database.query(
    `INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes)
     VALUES ($1, 'Resolver API', $2, $3, ARRAY['records:write'])`,
    [tenantId, token.slice(0, token.indexOf('.')), hashApiKey(token)],
  );
}

async function insertSource(database: Client, tenantId: string, name: string): Promise<void> {
  await database.query(
    `INSERT INTO source_systems (tenant_id, name, type)
     VALUES ($1, $2, 'api')`,
    [tenantId, name],
  );
}
