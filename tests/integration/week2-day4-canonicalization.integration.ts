import type { Server } from 'node:http';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { ResolutionDecision } from '@resolve/contracts';
import { type ResolvePrismaClient } from '@resolve/database';
import { Client } from 'pg';
import request from 'supertest';

import type { ResolveApplication } from '../../apps/api/src/application.js';
import { hashApiKey } from '../../apps/api/src/auth/api-key.js';
import { CanonicalizationDataIntegrityError } from '../../apps/api/src/canonicalization/canonicalization-data-integrity.error.js';
import { CanonicalizationService } from '../../apps/api/src/canonicalization/canonicalization.service.js';
import { PRISMA_CLIENT } from '../../apps/api/src/infrastructure/infrastructure.tokens.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const prismaCli = resolve(repositoryRoot, 'node_modules/prisma/build/index.js');
const prismaConfig = resolve(repositoryRoot, 'prisma.config.ts');
const recordsToken = 'rslv_test_800000000001.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
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
  operation: 'CREATED' | 'UPDATED' | 'UNCHANGED';
}

describe('Week 2 Day 4 transactional canonicalization', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = `resolve_week2_day4_canonical_${process.pid}_${Date.now()}`;
  const adminUrl = databaseUrlForSchema(baseDatabaseUrl);
  const isolatedUrl = databaseUrlForSchema(baseDatabaseUrl, schemaName);

  let admin: Client;
  let database: Client;
  let app: ResolveApplication;
  let prisma: ResolvePrismaClient;
  let canonicalization: CanonicalizationService;
  let tenantId: string;

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
    tenantId = await insertTenant(database, 'Canonicalization Tenant');
    await insertApiKey(database, tenantId, recordsToken);
    await insertSource(database, tenantId, 'canonical-low', 100);
    await insertSource(database, tenantId, 'canonical-high', 10);

    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    prisma = app.get(PRISMA_CLIENT);
    canonicalization = app.get(CanonicalizationService);
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

  it('creates canonical version one with current provenance and one snapshot for NO_MATCH', async () => {
    const response = await ingest(app, {
      source: 'canonical-low',
      external_id: 'canonical-create',
      entity_type: 'person',
      data: { name: 'Abdulkerim Hassen', email: 'abdul@example.com' },
    }).expect(201);
    const body = response.body as RecordResponseBody;
    expect(body).toMatchObject({ decision: 'NO_MATCH', operation: 'CREATED' });

    const entity = await database.query<{
      canonical_version: number;
      canonical_data: Record<string, unknown>;
    }>('SELECT canonical_version, canonical_data FROM entities WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      body.entity_id,
    ]);
    expect(entity.rows[0]).toMatchObject({
      canonical_version: 1,
      canonical_data: {
        name: 'Abdulkerim Hassen',
        email: 'abdul@example.com',
      },
    });

    const currentProvenance = await loadCurrentProvenance(database, tenantId, body.entity_id);
    expect(currentProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field_path: 'name',
          source_record_id: body.record_id,
          selection_rule: 'ONLY_CANDIDATE',
          canonicalization_version: 'canonicalization-v1',
        }),
      ]),
    );
    const history = await loadHistory(database, tenantId, body.entity_id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      version: 1,
      trigger_source_record_id: body.record_id,
      trigger_operation: 'ENTITY_CREATED',
      canonicalization_version: 'canonicalization-v1',
    });
  });

  it('does not mutate canonical state when resolution returns REVIEW', async () => {
    const base = await ingest(app, {
      source: 'canonical-low',
      external_id: 'canonical-review-base',
      entity_type: 'person',
      data: {
        name: 'Review Person',
        phone: '+251911000001',
        address: { city: 'Addis Ababa', country: 'ET' },
      },
    }).expect(201);
    const baseBody = base.body as RecordResponseBody;
    const beforeEntity = await prisma.entity.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: baseBody.entity_id } },
    });
    const beforeProvenance = await loadCurrentProvenance(database, tenantId, baseBody.entity_id);
    const beforeHistory = await loadHistory(database, tenantId, baseBody.entity_id);

    const review = await ingest(app, {
      source: 'canonical-low',
      external_id: 'canonical-review-incoming',
      entity_type: 'person',
      data: {
        name: 'Review Person',
        phone: '+251911000002',
        address: { city: 'Addis Ababa', country: 'ET' },
      },
    }).expect(201);
    const reviewBody = review.body as RecordResponseBody;
    expect(reviewBody).toMatchObject({ decision: 'REVIEW', entity_id: baseBody.entity_id });

    const afterEntity = await prisma.entity.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: baseBody.entity_id } },
    });
    expect(afterEntity.canonicalVersion).toBe(1);
    expect(afterEntity.canonicalData).toEqual(beforeEntity.canonicalData);
    expect(await loadCurrentProvenance(database, tenantId, baseBody.entity_id)).toEqual(
      beforeProvenance,
    );
    expect(await loadHistory(database, tenantId, baseBody.entity_id)).toEqual(beforeHistory);
    expect(
      await prisma.entityRecordLink.count({
        where: { tenantId, sourceRecordId: reviewBody.record_id },
      }),
    ).toBe(0);
  });

  it('replaces a lower-authority canonical winner after an automatic match', async () => {
    const lower = await ingest(app, {
      source: 'canonical-low',
      external_id: 'authority-low',
      entity_type: 'person',
      data: {
        name: 'ABDULKERIM HASSEN',
        email: 'authority@example.com',
        phone: '+251911300001',
        company: 'Acme Trading PLC',
        address: { city: 'Addis Ababa', country: 'ET' },
      },
    }).expect(201);
    const lowerBody = lower.body as RecordResponseBody;

    const higher = await ingest(app, {
      source: 'canonical-high',
      external_id: 'authority-high',
      entity_type: 'person',
      data: {
        name: 'Abdulkerim Hassen',
        email: 'authority@example.com',
        phone: '+251911300001',
        company: 'Acme Trading PLC',
        address: { city: 'Addis Ababa', country: 'ET' },
      },
    }).expect(201);
    const higherBody = higher.body as RecordResponseBody;
    expect(higherBody).toMatchObject({
      decision: 'AUTO_MATCH',
      entity_id: lowerBody.entity_id,
    });

    const entity = await prisma.entity.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: lowerBody.entity_id } },
    });
    expect(entity.canonicalVersion).toBe(2);
    expect(entity.canonicalData).toMatchObject({ name: 'Abdulkerim Hassen' });
    const provenance = await loadCurrentProvenance(database, tenantId, lowerBody.entity_id);
    expect(provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field_path: 'name',
          source_record_id: higherBody.record_id,
          selection_rule: 'SOURCE_PRIORITY',
        }),
      ]),
    );
    const history = await loadHistory(database, tenantId, lowerBody.entity_id);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      version: 2,
      trigger_source_record_id: higherBody.record_id,
      trigger_operation: 'RECORD_LINKED',
    });
  });

  it('recomputes an updated linked record and writes nothing for an unchanged replay', async () => {
    const originalPayload = {
      source: 'canonical-low',
      external_id: 'canonical-update',
      entity_type: 'person',
      data: { name: 'Original Canonical Name', email: 'update@example.com' },
    };
    const created = await ingest(app, originalPayload).expect(201);
    const createdBody = created.body as RecordResponseBody;

    const updatedPayload = {
      ...originalPayload,
      data: { name: 'Updated Canonical Name', email: 'update@example.com' },
    };
    const updated = await ingest(app, updatedPayload).expect(200);
    const updatedBody = updated.body as RecordResponseBody;
    expect(updatedBody).toMatchObject({
      entity_id: createdBody.entity_id,
      operation: 'UPDATED',
    });
    const afterUpdate = await prisma.entity.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: createdBody.entity_id } },
    });
    expect(afterUpdate.canonicalVersion).toBe(2);
    expect(afterUpdate.canonicalData).toMatchObject({ name: 'Updated Canonical Name' });
    expect((await loadHistory(database, tenantId, createdBody.entity_id))[1]).toMatchObject({
      version: 2,
      trigger_source_record_id: createdBody.record_id,
      trigger_operation: 'RECORD_UPDATED',
    });

    const beforeReplayProvenance = await loadCurrentProvenance(
      database,
      tenantId,
      createdBody.entity_id,
    );
    const beforeReplayHistory = await loadHistory(database, tenantId, createdBody.entity_id);
    const replay = await ingest(app, updatedPayload).expect(200);
    expect(replay.body).toMatchObject({
      entity_id: createdBody.entity_id,
      operation: 'UNCHANGED',
    });
    const afterReplay = await prisma.entity.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: createdBody.entity_id } },
    });
    expect(afterReplay.canonicalVersion).toBe(2);
    expect(await loadCurrentProvenance(database, tenantId, createdBody.entity_id)).toEqual(
      beforeReplayProvenance,
    );
    expect(await loadHistory(database, tenantId, createdBody.entity_id)).toEqual(
      beforeReplayHistory,
    );
  });

  it('rejects an unchanged replay when positive canonical state has no history', async () => {
    const created = await ingest(app, {
      source: 'canonical-low',
      external_id: 'canonical-missing-history',
      entity_type: 'person',
      data: { name: 'Missing History Person', email: 'missing-history@example.com' },
    }).expect(201);
    const body = created.body as RecordResponseBody;
    await database.query(
      'DELETE FROM entity_canonical_versions WHERE tenant_id = $1 AND entity_id = $2',
      [tenantId, body.entity_id],
    );

    await expect(
      prisma.$transaction((transaction) =>
        canonicalization.canonicalizeLinkedEntity(transaction, {
          tenantId,
          entityId: body.entity_id,
          sourceRecordId: body.record_id,
          ingestionOperation: 'UNCHANGED',
          resolutionDecision: ResolutionDecision.NoMatch,
        }),
      ),
    ).rejects.toThrow(CanonicalizationDataIntegrityError);
  });

  it('rejects an unchanged replay when latest history does not match canonical version', async () => {
    const created = await ingest(app, {
      source: 'canonical-low',
      external_id: 'canonical-mismatched-history',
      entity_type: 'person',
      data: { name: 'Mismatched History Person', email: 'mismatched-history@example.com' },
    }).expect(201);
    const body = created.body as RecordResponseBody;
    await database.query(
      `UPDATE entity_canonical_versions
       SET version = 2
       WHERE tenant_id = $1 AND entity_id = $2`,
      [tenantId, body.entity_id],
    );

    await expect(
      prisma.$transaction((transaction) =>
        canonicalization.canonicalizeLinkedEntity(transaction, {
          tenantId,
          entityId: body.entity_id,
          sourceRecordId: body.record_id,
          ingestionOperation: 'UNCHANGED',
          resolutionDecision: ResolutionDecision.NoMatch,
        }),
      ),
    ).rejects.toThrow(CanonicalizationDataIntegrityError);
  });

  it('creates exactly one LEGACY_BACKFILL for an unchanged linked version-zero entity', async () => {
    const payload = {
      source: 'canonical-low',
      external_id: 'canonical-legacy',
      entity_type: 'person',
      data: { name: 'Legacy Canonical Person', email: 'legacy@example.com' },
    };
    const created = await ingest(app, payload).expect(201);
    const createdBody = created.body as RecordResponseBody;
    await database.query(
      'DELETE FROM entity_field_provenance WHERE tenant_id = $1 AND entity_id = $2',
      [tenantId, createdBody.entity_id],
    );
    await database.query(
      'DELETE FROM entity_canonical_versions WHERE tenant_id = $1 AND entity_id = $2',
      [tenantId, createdBody.entity_id],
    );
    await database.query(
      `UPDATE entities
       SET canonical_data = '{}'::jsonb, canonical_version = 0
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, createdBody.entity_id],
    );

    const backfilled = await ingest(app, payload).expect(200);
    expect(backfilled.body).toMatchObject({ operation: 'UNCHANGED' });
    const entity = await prisma.entity.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: createdBody.entity_id } },
    });
    expect(entity.canonicalVersion).toBe(1);
    expect(await loadHistory(database, tenantId, createdBody.entity_id)).toEqual([
      expect.objectContaining({
        version: 1,
        trigger_source_record_id: createdBody.record_id,
        trigger_operation: 'LEGACY_BACKFILL',
      }),
    ]);

    await ingest(app, payload).expect(200);
    expect(
      await prisma.entityCanonicalVersion.count({
        where: { tenantId, entityId: createdBody.entity_id },
      }),
    ).toBe(1);
    expect(
      await prisma.entityFieldProvenance.count({
        where: { tenantId, entityId: createdBody.entity_id },
      }),
    ).toBeGreaterThan(0);
  });

  it('serializes concurrent qualifying ingestions into distinct sequential versions', async () => {
    const sharedData = {
      name: 'Concurrent Canonical Person',
      email: 'canonical-concurrent@example.com',
      phone: '+251911400001',
      company: 'Concurrent Trading PLC',
      address: { city: 'Addis Ababa', country: 'ET' },
    };
    const base = await ingest(app, {
      source: 'canonical-low',
      external_id: 'canonical-concurrent-base',
      entity_type: 'person',
      data: sharedData,
    }).expect(201);
    const baseBody = base.body as RecordResponseBody;

    const [withRegion, withPostalCode] = await Promise.all([
      ingest(app, {
        source: 'canonical-low',
        external_id: 'canonical-concurrent-region',
        entity_type: 'person',
        data: {
          ...sharedData,
          address: { ...sharedData.address, region: 'Addis Ababa' },
        },
      }),
      ingest(app, {
        source: 'canonical-low',
        external_id: 'canonical-concurrent-postal',
        entity_type: 'person',
        data: {
          ...sharedData,
          address: { ...sharedData.address, postal_code: '1000' },
        },
      }),
    ]);
    expect([withRegion.status, withPostalCode.status]).toEqual([201, 201]);
    expect(withRegion.body).toMatchObject({
      decision: 'AUTO_MATCH',
      entity_id: baseBody.entity_id,
    });
    expect(withPostalCode.body).toMatchObject({
      decision: 'AUTO_MATCH',
      entity_id: baseBody.entity_id,
    });

    const entity = await prisma.entity.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: baseBody.entity_id } },
    });
    expect(entity.canonicalVersion).toBe(3);
    expect(entity.canonicalData).toMatchObject({
      address: { region: 'Addis Ababa', postal_code: '1000' },
    });
    const history = await loadHistory(database, tenantId, baseBody.entity_id);
    expect(history.map(({ version }) => version)).toEqual([1, 2, 3]);
    expect(history.slice(1).map(({ trigger_operation }) => trigger_operation)).toEqual([
      'RECORD_LINKED',
      'RECORD_LINKED',
    ]);
  });

  it('does not churn canonical state when a newly linked lower-priority record loses survivorship', async () => {
    await insertSource(database, tenantId, 'canonical-lower', 200);
    const sharedData = {
      name: 'Stable Authority Person',
      email: 'stable-authority@example.com',
      phone: '+251911450001',
      company: 'Stable Authority PLC',
      address: { city: 'Addis Ababa', country: 'ET' },
    };
    const winner = await ingest(app, {
      source: 'canonical-high',
      external_id: 'stable-authority-winner',
      entity_type: 'person',
      data: sharedData,
    }).expect(201);
    const winnerBody = winner.body as RecordResponseBody;
    await ingest(app, {
      source: 'canonical-low',
      external_id: 'stable-authority-runner-up',
      entity_type: 'person',
      data: sharedData,
    }).expect(201);

    const beforeEntity = await prisma.entity.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: winnerBody.entity_id } },
    });
    const beforeProvenance = await prisma.entityFieldProvenance.findMany({
      where: { tenantId, entityId: winnerBody.entity_id },
      orderBy: { fieldPath: 'asc' },
    });
    const beforeHistory = await prisma.entityCanonicalVersion.findMany({
      where: { tenantId, entityId: winnerBody.entity_id },
      orderBy: { version: 'asc' },
    });
    expect(beforeEntity.canonicalVersion).toBe(2);
    expect(beforeHistory).toHaveLength(2);

    const losingLink = await ingest(app, {
      source: 'canonical-lower',
      external_id: 'stable-authority-losing-link',
      entity_type: 'person',
      data: sharedData,
    }).expect(201);
    expect(losingLink.body).toMatchObject({
      decision: 'AUTO_MATCH',
      entity_id: winnerBody.entity_id,
    });

    expect(
      await prisma.entity.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: winnerBody.entity_id } },
      }),
    ).toEqual(beforeEntity);
    expect(
      await prisma.entityFieldProvenance.findMany({
        where: { tenantId, entityId: winnerBody.entity_id },
        orderBy: { fieldPath: 'asc' },
      }),
    ).toEqual(beforeProvenance);
    expect(
      await prisma.entityCanonicalVersion.findMany({
        where: { tenantId, entityId: winnerBody.entity_id },
        orderBy: { version: 'asc' },
      }),
    ).toEqual(beforeHistory);
  });

  it('does not update raw source payloads or immutable record versions during canonicalization', async () => {
    const lowerPayload = {
      name: 'IMMUTABLE CANONICAL PERSON',
      email: 'canonical-immutable@example.com',
      phone: '+251911500001',
      company: 'Immutable Trading PLC',
      address: { city: 'Addis Ababa', country: 'et' },
    };
    const lower = await ingest(app, {
      source: 'canonical-low',
      external_id: 'canonical-immutable-low',
      entity_type: 'person',
      data: lowerPayload,
    }).expect(201);
    const lowerBody = lower.body as RecordResponseBody;
    const beforeRecord = await loadRawRecord(database, tenantId, lowerBody.record_id);
    const beforeVersions = await loadRawVersions(database, tenantId, lowerBody.record_id);

    const higher = await ingest(app, {
      source: 'canonical-high',
      external_id: 'canonical-immutable-high',
      entity_type: 'person',
      data: {
        ...lowerPayload,
        name: 'Immutable Canonical Person',
      },
    }).expect(201);
    expect(higher.body).toMatchObject({
      decision: 'AUTO_MATCH',
      entity_id: lowerBody.entity_id,
    });

    expect(await loadRawRecord(database, tenantId, lowerBody.record_id)).toEqual(beforeRecord);
    expect(await loadRawVersions(database, tenantId, lowerBody.record_id)).toEqual(beforeVersions);
    expect(beforeRecord).toEqual({ raw_payload: lowerPayload, current_version: 1 });
    expect(beforeVersions).toEqual([{ version: 1, raw_payload: lowerPayload }]);
  });
});

function ingest(app: ResolveApplication, payload: Record<string, unknown>): request.Test {
  return request(app.getHttpServer() as Server)
    .post('/v1/records')
    .set('Authorization', 'Bearer ' + recordsToken)
    .send(payload);
}

async function loadCurrentProvenance(
  database: Client,
  tenantId: string,
  entityId: string,
): Promise<
  Array<{
    field_path: string;
    source_record_id: string;
    selection_rule: string;
    canonicalization_version: string;
  }>
> {
  const result = await database.query<{
    field_path: string;
    source_record_id: string;
    selection_rule: string;
    canonicalization_version: string;
  }>(
    `SELECT field_path, source_record_id, selection_rule, canonicalization_version
     FROM entity_field_provenance
     WHERE tenant_id = $1 AND entity_id = $2
     ORDER BY field_path`,
    [tenantId, entityId],
  );
  return result.rows;
}

async function loadHistory(
  database: Client,
  tenantId: string,
  entityId: string,
): Promise<
  Array<{
    version: number;
    trigger_source_record_id: string | null;
    trigger_operation: string;
    canonicalization_version: string;
  }>
> {
  const result = await database.query<{
    version: number;
    trigger_source_record_id: string | null;
    trigger_operation: string;
    canonicalization_version: string;
  }>(
    `SELECT version, trigger_source_record_id, trigger_operation, canonicalization_version
     FROM entity_canonical_versions
     WHERE tenant_id = $1 AND entity_id = $2
     ORDER BY version`,
    [tenantId, entityId],
  );
  return result.rows;
}

async function loadRawRecord(
  database: Client,
  tenantId: string,
  sourceRecordId: string,
): Promise<{ raw_payload: Record<string, unknown>; current_version: number }> {
  const result = await database.query<{
    raw_payload: Record<string, unknown>;
    current_version: number;
  }>(
    `SELECT raw_payload, current_version
     FROM source_records
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, sourceRecordId],
  );
  return result.rows[0]!;
}

async function loadRawVersions(
  database: Client,
  tenantId: string,
  sourceRecordId: string,
): Promise<Array<{ version: number; raw_payload: Record<string, unknown> }>> {
  const result = await database.query<{
    version: number;
    raw_payload: Record<string, unknown>;
  }>(
    `SELECT version, raw_payload
     FROM source_record_versions
     WHERE tenant_id = $1 AND source_record_id = $2
     ORDER BY version`,
    [tenantId, sourceRecordId],
  );
  return result.rows;
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
     VALUES ($1, 'Canonicalization integration key', $2, $3, $4)`,
    [tenantId, token.split('.')[0], hashApiKey(token), ['records:write']],
  );
}

async function insertSource(
  database: Client,
  tenantId: string,
  name: string,
  priority: number,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO source_systems (tenant_id, name, type, priority)
     VALUES ($1, $2, 'api', $3) RETURNING id`,
    [tenantId, name, priority],
  );
  return result.rows[0]!.id;
}
