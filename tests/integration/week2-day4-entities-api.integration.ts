import type { Server } from 'node:http';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from 'pg';
import request from 'supertest';

import type { ResolveApplication } from '../../apps/api/src/application.js';
import { hashApiKey } from '../../apps/api/src/auth/api-key.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const prismaCli = resolve(repositoryRoot, 'node_modules/prisma/build/index.js');
const prismaConfig = resolve(repositoryRoot, 'prisma.config.ts');
const entityReadToken = 'rslv_test_810000000001.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const wrongScopeToken = 'rslv_test_810000000002.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const revokedToken = 'rslv_test_810000000003.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const foreignReadToken = 'rslv_test_810000000004.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const invalidToken = 'rslv_test_819999999999.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const entityId = '10000000-0000-4000-8000-000000000001';
const legacyEntityId = '10000000-0000-4000-8000-000000000002';
const foreignEntityId = '20000000-0000-4000-8000-000000000001';
const missingEntityId = '90000000-0000-4000-8000-000000000001';
const originalEnvironment = {
  BLOCKING_MAX_CANDIDATES: process.env.BLOCKING_MAX_CANDIDATES,
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  API_PORT: process.env.API_PORT,
  REDIS_HOST: process.env.REDIS_HOST,
  REDIS_PORT: process.env.REDIS_PORT,
  REQUEST_BODY_LIMIT: process.env.REQUEST_BODY_LIMIT,
};

interface PageBody<T> {
  items: T[];
  next_cursor: string | null;
}

interface LinkedRecordBody {
  record_id: string;
  entity_type: string;
  external_id: string;
  source: {
    source_system_id: string;
    name: string;
    type: string;
    priority: number;
  };
  raw_payload: Record<string, unknown>;
  normalized_payload: Record<string, unknown>;
  normalization_version: string;
  record_created_at: string;
  record_updated_at: string;
  link: {
    decision: string;
    confidence: number;
    algorithm_version: string;
    explanation: Record<string, unknown>;
    linked_at: string;
  };
}

interface HistoryBody {
  version: number;
  canonical_data: Record<string, unknown>;
  provenance: Record<string, unknown>;
  trigger: { operation: string; source_record_id: string | null };
  canonicalization_version: string;
  created_at: string;
}

describe('Week 2 Day 4 entity read API', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = `resolve_week2_day4_entities_${process.pid}_${Date.now()}`;
  const adminUrl = databaseUrlForSchema(baseDatabaseUrl);
  const isolatedUrl = databaseUrlForSchema(baseDatabaseUrl, schemaName);

  let admin: Client;
  let database: Client;
  let app: ResolveApplication;
  let tenantId: string;
  let foreignTenantId: string;
  let sourceId: string;
  let recordIds: string[];

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
    tenantId = await insertTenant(database, 'Entity Read Tenant');
    foreignTenantId = await insertTenant(database, 'Foreign Entity Read Tenant');
    await insertApiKey(database, tenantId, entityReadToken, ['entities:read']);
    await insertApiKey(database, tenantId, wrongScopeToken, ['records:write']);
    await insertApiKey(database, tenantId, revokedToken, ['entities:read'], new Date());
    await insertApiKey(database, foreignTenantId, foreignReadToken, ['entities:read']);
    sourceId = await insertSource(database, tenantId, 'verified-crm', 10);
    await insertSource(database, foreignTenantId, 'foreign-crm', 10);
    recordIds = await seedCurrentEntity(database, tenantId, sourceId);
    await seedLegacyEntity(database, tenantId);
    await seedForeignEntity(database, foreignTenantId);

    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
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

  it.each(['', '/records', '/history'])(
    'requires a valid non-revoked key with entities:read for %s',
    async (suffix) => {
      const server = app.getHttpServer() as Server;
      const path = `/v1/entities/${entityId}${suffix}`;
      await request(server).get(path).expect(401);
      await request(server)
        .get(path)
        .set('Authorization', 'Bearer ' + invalidToken)
        .expect(401);
      await request(server)
        .get(path)
        .set('Authorization', 'Bearer ' + revokedToken)
        .expect(401);
      await request(server)
        .get(path)
        .set('Authorization', 'Bearer ' + wrongScopeToken)
        .expect(403)
        .expect(({ body }) => {
          expect(body).toEqual({
            error: {
              code: 'INSUFFICIENT_SCOPE',
              message: 'API key lacks a required scope',
            },
          });
        });
    },
  );

  it('returns the current entity and nested field provenance without mutating state', async () => {
    const before = await loadVersionState(database, tenantId, entityId);

    await entityGet(app, entityReadToken, entityId)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          entity_id: entityId,
          entity_type: 'person',
          canonical_data: {
            name: 'Current Person',
            address: { city: 'Addis Ababa' },
          },
          canonical_version: 3,
          canonicalization_version: 'canonicalization-v1',
          provenance: {
            name: {
              source_record_id: recordIds[0],
              source_system_id: sourceId,
              source_system_name: 'verified-crm',
              external_id: 'record-1',
              source_priority: 10,
              raw_value: ' Current Person ',
              canonical_value: 'Current Person',
              selection_rule: 'SOURCE_PRIORITY',
              completeness_score: 14,
              normalization_version: 'normalization-v1',
              canonicalization_version: 'canonicalization-v1',
            },
            address: {
              city: {
                source_record_id: recordIds[0],
                canonical_value: 'Addis Ababa',
              },
            },
          },
          record_count: 3,
        });
        expect(body).toMatchObject({
          created_at: '2026-09-09T09:00:00.000Z',
          updated_at: '2026-09-09T12:00:00.000Z',
          provenance: { name: { observed_at: '2026-09-09T10:00:00.000Z' } },
        });
      });

    expect(await loadVersionState(database, tenantId, entityId)).toEqual(before);
  });

  it.each(['', '/records', '/history'])(
    'returns the same not-found response for absent and cross-tenant entities for %s',
    async (suffix) => {
      const expected = {
        error: { code: 'ENTITY_NOT_FOUND', message: 'Entity does not exist' },
      };
      await authenticatedGet(app, entityReadToken, `/v1/entities/${missingEntityId}${suffix}`)
        .expect(404)
        .expect(expected);
      await authenticatedGet(app, entityReadToken, `/v1/entities/${foreignEntityId}${suffix}`)
        .expect(404)
        .expect(expected);
      await authenticatedGet(app, foreignReadToken, `/v1/entities/${entityId}${suffix}`)
        .expect(404)
        .expect(expected);
    },
  );

  it.each([
    ['/v1/entities/not-a-uuid', 'malformed entity ID'],
    ['/v1/entities/not-a-uuid/records', 'malformed records entity ID'],
    ['/v1/entities/not-a-uuid/history', 'malformed history entity ID'],
    [`/v1/entities/${entityId}/records?limit=0`, 'zero records limit'],
    [`/v1/entities/${entityId}/records?limit=101`, 'oversized records limit'],
    [`/v1/entities/${entityId}/history?limit=1.5`, 'fractional history limit'],
  ])('rejects %s (%s)', async (path) => {
    await authenticatedGet(app, entityReadToken, path).expect(400);
  });

  it.each(['records', 'history'])('rejects a malformed %s cursor', async (collection) => {
    await authenticatedGet(
      app,
      entityReadToken,
      `/v1/entities/${entityId}/${collection}?cursor=not-a-cursor!`,
    )
      .expect(400)
      .expect({
        error: { code: 'INVALID_CURSOR', message: 'Cursor is invalid' },
      });
  });

  it.each(['records', 'history'])('rejects an empty %s cursor', async (collection) => {
    await authenticatedGet(app, entityReadToken, `/v1/entities/${entityId}/${collection}?cursor=`)
      .expect(400)
      .expect({ error: { code: 'INVALID_CURSOR', message: 'Cursor is invalid' } });
  });

  it('returns linked records in stable cursor pages with current payload and link evidence', async () => {
    const before = await loadVersionState(database, tenantId, entityId);
    const firstResponse = await authenticatedGet(
      app,
      entityReadToken,
      `/v1/entities/${entityId}/records?limit=2`,
    ).expect(200);
    const first = firstResponse.body as PageBody<LinkedRecordBody>;
    expect(first.items.map(({ external_id }) => external_id)).toEqual(['record-3', 'record-2']);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.items[0]).toMatchObject({
      entity_type: 'person',
      source: {
        source_system_id: sourceId,
        name: 'verified-crm',
        type: 'CRM',
        priority: 10,
      },
      raw_payload: { name: 'Record Three', email: 'three@example.com' },
      normalized_payload: { name: 'record three', email: 'three@example.com' },
      normalization_version: 'normalization-v1',
      record_created_at: '2026-09-09T10:20:00.000Z',
      record_updated_at: '2026-09-09T10:30:00.000Z',
      link: {
        decision: 'AUTO_MATCH',
        confidence: 0.963,
        algorithm_version: 'rules-0.1.0',
        explanation: {
          candidate_count: 2,
          features: { email_exact: true },
          contradictions: [],
        },
        linked_at: '2026-09-09T10:40:00.000Z',
      },
    });

    const secondResponse = await authenticatedGet(
      app,
      entityReadToken,
      `/v1/entities/${entityId}/records?limit=2&cursor=${first.next_cursor}`,
    ).expect(200);
    const second = secondResponse.body as PageBody<LinkedRecordBody>;
    expect(second.items.map(({ external_id }) => external_id)).toEqual(['record-1']);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(({ record_id }) => record_id)).size).toBe(
      3,
    );
    expect(await loadVersionState(database, tenantId, entityId)).toEqual(before);
  });

  it('returns immutable history in descending stable cursor pages', async () => {
    const before = await loadVersionState(database, tenantId, entityId);
    const firstResponse = await authenticatedGet(
      app,
      entityReadToken,
      `/v1/entities/${entityId}/history?limit=2`,
    ).expect(200);
    const first = firstResponse.body as PageBody<HistoryBody>;
    expect(first.items.map(({ version }) => version)).toEqual([3, 2]);
    expect(first.items[0]).toMatchObject({
      version: 3,
      canonical_data: { name: 'Current Person', address: { city: 'Addis Ababa' } },
      provenance: { name: { external_id: 'record-1' } },
      trigger: {
        operation: 'RECORD_UPDATED',
        source_record_id: recordIds[2],
      },
      canonicalization_version: 'canonicalization-v1',
      created_at: '2026-09-09T12:00:00.000Z',
    });
    expect(first.next_cursor).toEqual(expect.any(String));

    const secondResponse = await authenticatedGet(
      app,
      entityReadToken,
      `/v1/entities/${entityId}/history?limit=2&cursor=${first.next_cursor}`,
    ).expect(200);
    const second = secondResponse.body as PageBody<HistoryBody>;
    expect(second.items.map(({ version }) => version)).toEqual([1]);
    expect(second.items[0]!.trigger.source_record_id).toBeNull();
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(({ version }) => version)).size).toBe(3);
    expect(await loadVersionState(database, tenantId, entityId)).toEqual(before);
  });

  it('maps ingested history provenance to the public contract with historical source metadata', async () => {
    const lowerPrioritySourceId = await insertSource(database, tenantId, 'history-import', 20);
    const higherPrioritySourceId = await insertSource(database, tenantId, 'history-verified', 5);
    const ingest = (source: string, externalId: string): request.Test =>
      request(app.getHttpServer() as Server)
        .post('/v1/records')
        .set('Authorization', 'Bearer ' + wrongScopeToken)
        .send({
          source,
          external_id: externalId,
          entity_type: 'person',
          data: {
            name: 'History Contract Person',
            email: 'history-contract@example.com',
            phone: '+251911123456',
            address: { city: 'Addis Ababa', country: 'ET' },
          },
        });
    const first = await ingest('history-import', 'history-first').expect(201);
    const second = await ingest('history-verified', 'history-winner').expect(201);
    const firstBody = first.body as { entity_id: string; record_id: string };
    const secondBody = second.body as { entity_id: string; record_id: string; decision: string };
    expect(secondBody).toMatchObject({ entity_id: firstBody.entity_id, decision: 'AUTO_MATCH' });

    const current = await entityGet(app, entityReadToken, firstBody.entity_id).expect(200);
    const currentBody = current.body as { provenance: Record<string, unknown> };
    expect(currentBody.provenance).toMatchObject({
      name: {
        source_record_id: secondBody.record_id,
        source_system_id: higherPrioritySourceId,
        source_system_name: 'history-verified',
        external_id: 'history-winner',
        source_priority: 5,
        selection_rule: 'SOURCE_PRIORITY',
      },
      address: { city: { canonical_value: 'Addis Ababa', source_record_id: secondBody.record_id } },
    });
    await database.query('UPDATE source_systems SET name = $2, priority = 99 WHERE id = $1', [
      higherPrioritySourceId,
      'history-renamed',
    ]);

    const historyResponse = await authenticatedGet(
      app,
      entityReadToken,
      `/v1/entities/${firstBody.entity_id}/history`,
    ).expect(200);
    const history = historyResponse.body as PageBody<HistoryBody>;
    expect(history.items.map(({ version }) => version)).toEqual([2, 1]);
    expect(history.items[0]!.provenance).toEqual(currentBody.provenance);
    expect(history.items[1]!.provenance).toMatchObject({
      name: {
        source_record_id: firstBody.record_id,
        source_system_id: lowerPrioritySourceId,
        source_system_name: 'history-import',
        source_priority: 20,
        selection_rule: 'ONLY_CANDIDATE',
      },
    });
  });

  it.each([
    ['array root', []],
    ['array address', { address: [] }],
    ['incomplete field', { name: { externalId: 'record-1' } }],
    ['unknown field', { unknown: {} }],
  ])('rejects malformed stored history provenance (%s)', async (_description, provenance) => {
    const original = await database.query<{ provenance: unknown }>(
      'SELECT provenance FROM entity_canonical_versions WHERE tenant_id = $1 AND entity_id = $2 AND version = 3',
      [tenantId, entityId],
    );
    try {
      await database.query(
        'UPDATE entity_canonical_versions SET provenance = $3::jsonb WHERE tenant_id = $1 AND entity_id = $2 AND version = 3',
        [tenantId, entityId, JSON.stringify(provenance)],
      );
      await authenticatedGet(app, entityReadToken, `/v1/entities/${entityId}/history`)
        .expect(500)
        .expect({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    } finally {
      await database.query(
        'UPDATE entity_canonical_versions SET provenance = $3::jsonb WHERE tenant_id = $1 AND entity_id = $2 AND version = 3',
        [tenantId, entityId, JSON.stringify(original.rows[0]!.provenance)],
      );
    }
  });

  it('returns stored version-zero canonical data without provenance or policy version', async () => {
    const before = await loadVersionState(database, tenantId, legacyEntityId);
    await entityGet(app, entityReadToken, legacyEntityId)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          entity_id: legacyEntityId,
          entity_type: 'company',
          canonical_data: { name: 'Legacy Stored Company' },
          canonical_version: 0,
          canonicalization_version: null,
          provenance: {},
          record_count: 0,
        });
      });
    expect(await loadVersionState(database, tenantId, legacyEntityId)).toEqual(before);
  });

  it.each(['records', 'history'])('returns an empty legacy %s page', async (collection) => {
    await authenticatedGet(app, entityReadToken, `/v1/entities/${legacyEntityId}/${collection}`)
      .expect(200)
      .expect({ items: [], next_cursor: null });
  });

  it('rejects malformed stored canonical JSON without exposing internal data', async () => {
    const original = await database.query<{ canonical_data: unknown }>(
      'SELECT canonical_data FROM entities WHERE tenant_id = $1 AND id = $2',
      [tenantId, legacyEntityId],
    );
    try {
      await database.query(
        "UPDATE entities SET canonical_data = '[]'::jsonb WHERE tenant_id = $1 AND id = $2",
        [tenantId, legacyEntityId],
      );
      await entityGet(app, entityReadToken, legacyEntityId)
        .expect(500)
        .expect({
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
    } finally {
      await database.query(
        'UPDATE entities SET canonical_data = $3::jsonb WHERE tenant_id = $1 AND id = $2',
        [tenantId, legacyEntityId, JSON.stringify(original.rows[0]!.canonical_data)],
      );
    }
  });

  it('publishes bearer-authenticated entity routes, pagination, schemas, and errors', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/docs-json')
      .expect(200);
    const document = response.body as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    for (const path of [
      '/v1/entities/{entityId}',
      '/v1/entities/{entityId}/records',
      '/v1/entities/{entityId}/history',
    ]) {
      expect(document.paths).toHaveProperty([path, 'get']);
      const operation = document.paths[path]!.get as {
        security?: unknown;
        parameters?: Array<{ name: string }>;
        responses?: Record<string, unknown>;
      };
      expect(operation.security).toEqual([{ 'api-key': [] }]);
      for (const status of ['200', '400', '401', '403', '404']) {
        expect(operation.responses).toHaveProperty(status);
      }
    }
    expect(
      (
        document.paths['/v1/entities/{entityId}/records']!.get as {
          parameters: Array<{ name: string }>;
        }
      ).parameters.map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['entityId', 'limit', 'cursor']));
    expect(
      (
        document.paths['/v1/entities/{entityId}/history']!.get as {
          parameters: Array<{ name: string }>;
        }
      ).parameters.map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['entityId', 'limit', 'cursor']));
    for (const schema of ['EntityResponseDto', 'LinkedRecordPageDto', 'EntityHistoryPageDto']) {
      expect(document.components.schemas).toHaveProperty(schema);
    }
  });

  it('reads one consistent snapshot while a concurrent canonical update commits', async () => {
    const writer = new Client({ connectionString: adminUrl });
    let writerTransactionOpen = false;
    let readPromise: Promise<request.Response> | undefined;
    await writer.connect();
    try {
      await writer.query('SET search_path TO ' + quoteIdentifier(schemaName));
      await writer.query('BEGIN');
      writerTransactionOpen = true;
      // Block only relation reads so the API loads the old entity before the writer commits.
      await writer.query('LOCK TABLE entity_field_provenance IN ACCESS EXCLUSIVE MODE');
      readPromise = entityGet(app, entityReadToken, entityId).then((response) => response);
      await waitForBlockedProvenanceRead(database, schemaName);

      await writer.query(
        `UPDATE entities
         SET canonical_version = 4,
             canonical_data = jsonb_set(canonical_data, '{name}', '"Concurrent Person"'::jsonb)
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, entityId],
      );
      await writer.query(
        `UPDATE entity_field_provenance
         SET canonical_value = '"Concurrent Person"'::jsonb,
             raw_value = '"Concurrent Person"'::jsonb
         WHERE tenant_id = $1 AND entity_id = $2 AND field_path = 'name'`,
        [tenantId, entityId],
      );
      await writer.query(
        `INSERT INTO entity_canonical_versions
           (tenant_id, entity_id, version, canonical_data, provenance,
            trigger_source_record_id, trigger_operation, canonicalization_version)
         SELECT tenant_id, id, 4, canonical_data, '{}'::jsonb,
                $3, 'RECORD_UPDATED', 'canonicalization-v1'
         FROM entities WHERE tenant_id = $1 AND id = $2`,
        [tenantId, entityId, recordIds[0]],
      );
      await writer.query('COMMIT');
      writerTransactionOpen = false;

      const response = await readPromise;
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        canonical_version: 3,
        canonical_data: { name: 'Current Person' },
        provenance: { name: { canonical_value: 'Current Person' } },
      });
      await entityGet(app, entityReadToken, entityId)
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            canonical_version: 4,
            canonical_data: { name: 'Concurrent Person' },
            provenance: { name: { canonical_value: 'Concurrent Person' } },
          });
        });
    } finally {
      if (writerTransactionOpen) await writer.query('ROLLBACK');
      await readPromise;
      await writer.end();
    }
  });
});

async function waitForBlockedProvenanceRead(database: Client, schemaName: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await database.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock' AND query LIKE $1 AND query LIKE $2
       ) AS waiting`,
      ['%entity_field_provenance%', '%' + schemaName + '%'],
    );
    if (result.rows[0]?.waiting) return;
    await delay(10);
  }
  throw new Error('API read did not reach the blocked provenance query');
}

function entityGet(
  app: ResolveApplication,
  token: string,
  requestedEntityId: string,
): request.Test {
  return authenticatedGet(app, token, `/v1/entities/${requestedEntityId}`);
}

function authenticatedGet(app: ResolveApplication, token: string, path: string): request.Test {
  return request(app.getHttpServer() as Server)
    .get(path)
    .set('Authorization', 'Bearer ' + token);
}

async function loadVersionState(
  database: Client,
  tenantId: string,
  requestedEntityId: string,
): Promise<{ canonical_version: number; history_count: number }> {
  const result = await database.query<{ canonical_version: number; history_count: number }>(
    `SELECT entity.canonical_version,
            COUNT(history.id)::INTEGER AS history_count
     FROM entities entity
     LEFT JOIN entity_canonical_versions history
       ON history.tenant_id = entity.tenant_id AND history.entity_id = entity.id
     WHERE entity.tenant_id = $1 AND entity.id = $2
     GROUP BY entity.canonical_version`,
    [tenantId, requestedEntityId],
  );
  return result.rows[0]!;
}

async function seedCurrentEntity(
  database: Client,
  tenantId: string,
  sourceSystemId: string,
): Promise<string[]> {
  await database.query(
    `INSERT INTO entities
       (id, tenant_id, entity_type, canonical_data, canonical_version, created_at, updated_at)
     VALUES ($1, $2, 'PERSON', $3::jsonb, 3, $4, $5)`,
    [
      entityId,
      tenantId,
      JSON.stringify({ name: 'Current Person', address: { city: 'Addis Ababa' } }),
      '2026-09-09T09:00:00.000Z',
      '2026-09-09T12:00:00.000Z',
    ],
  );
  const ids = [
    '11000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000003',
  ];
  const linkIds = [
    '12000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000002',
    '12000000-0000-4000-8000-000000000003',
  ];
  const records = [
    {
      externalId: 'record-1',
      raw: { name: ' Current Person ', address: { city: 'Addis Ababa' } },
      normalized: { name: 'current person', address: { city: 'addis ababa' } },
      createdAt: '2026-09-09T09:20:00.000Z',
      updatedAt: '2026-09-09T10:00:00.000Z',
      linkedAt: '2026-09-09T10:20:00.000Z',
      decision: 'NO_MATCH',
      confidence: 0,
    },
    {
      externalId: 'record-2',
      raw: { name: 'Record Two', email: 'two@example.com' },
      normalized: { name: 'record two', email: 'two@example.com' },
      createdAt: '2026-09-09T10:00:00.000Z',
      updatedAt: '2026-09-09T10:10:00.000Z',
      linkedAt: '2026-09-09T10:20:00.000Z',
      decision: 'AUTO_MATCH',
      confidence: 0.94,
    },
    {
      externalId: 'record-3',
      raw: { name: 'Record Three', email: 'three@example.com' },
      normalized: { name: 'record three', email: 'three@example.com' },
      createdAt: '2026-09-09T10:20:00.000Z',
      updatedAt: '2026-09-09T10:30:00.000Z',
      linkedAt: '2026-09-09T10:40:00.000Z',
      decision: 'AUTO_MATCH',
      confidence: 0.963,
    },
  ] as const;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    await database.query(
      `INSERT INTO source_records
         (id, tenant_id, source_system_id, external_id, entity_type, raw_payload,
          normalized_payload, normalization_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'PERSON', $5::jsonb, $6::jsonb, 'normalization-v1', $7, $8)`,
      [
        ids[index],
        tenantId,
        sourceSystemId,
        record.externalId,
        JSON.stringify(record.raw),
        JSON.stringify(record.normalized),
        record.createdAt,
        record.updatedAt,
      ],
    );
    await database.query(
      `INSERT INTO entity_record_links
         (id, tenant_id, entity_id, source_record_id, score, decision,
          algorithm_version, explanation, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'rules-0.1.0', $7::jsonb, $8, $8)`,
      [
        linkIds[index],
        tenantId,
        entityId,
        ids[index],
        record.confidence,
        record.decision,
        JSON.stringify({
          candidate_count: index,
          features: index === 2 ? { email_exact: true } : {},
          contradictions: [],
        }),
        record.linkedAt,
      ],
    );
  }
  await insertCurrentProvenance(database, tenantId, sourceSystemId, ids[0]!);
  for (let version = 1; version <= 3; version += 1) {
    await database.query(
      `INSERT INTO entity_canonical_versions
         (tenant_id, entity_id, version, canonical_data, provenance,
          trigger_source_record_id, trigger_operation, canonicalization_version, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, 'canonicalization-v1', $8)`,
      [
        tenantId,
        entityId,
        version,
        JSON.stringify(
          version === 3
            ? { name: 'Current Person', address: { city: 'Addis Ababa' } }
            : { name: `Person Version ${version}` },
        ),
        JSON.stringify({
          name: {
            canonicalValue: version === 3 ? 'Current Person' : `Person Version ${version}`,
            rawValue: ' Current Person ',
            sourceRecordId: ids[0],
            sourceSystemId,
            sourceSystemName: 'verified-crm',
            externalId: 'record-1',
            sourcePriority: 10,
            selectionRule: 'SOURCE_PRIORITY',
            completenessScore: 14,
            observedAt: '2026-09-09T10:00:00.000Z',
            normalizationVersion: 'normalization-v1',
            canonicalizationVersion: 'canonicalization-v1',
          },
        }),
        version === 1 ? null : ids[Math.min(version - 1, ids.length - 1)],
        version === 1 ? 'ENTITY_CREATED' : version === 3 ? 'RECORD_UPDATED' : 'RECORD_LINKED',
        `2026-09-09T${String(9 + version).padStart(2, '0')}:00:00.000Z`,
      ],
    );
  }
  return ids;
}

async function insertCurrentProvenance(
  database: Client,
  tenantId: string,
  sourceSystemId: string,
  sourceRecordId: string,
): Promise<void> {
  const base = [
    tenantId,
    entityId,
    sourceRecordId,
    sourceSystemId,
    'record-1',
    10,
    'SOURCE_PRIORITY',
    '2026-09-09T10:00:00.000Z',
    'normalization-v1',
    'canonicalization-v1',
  ];
  await database.query(
    `INSERT INTO entity_field_provenance
       (tenant_id, entity_id, field_path, canonical_value, raw_value, source_record_id,
        source_system_id, source_external_id, source_priority, selection_rule,
        completeness_score, observed_at, normalization_version, canonicalization_version)
     VALUES ($1, $2, 'name', $11::jsonb, $12::jsonb, $3, $4, $5, $6, $7, 14, $8, $9, $10),
            ($1, $2, 'address.city', $13::jsonb, $13::jsonb, $3, $4, $5, $6, $7, 11, $8, $9, $10)`,
    [
      ...base,
      JSON.stringify('Current Person'),
      JSON.stringify(' Current Person '),
      JSON.stringify('Addis Ababa'),
    ],
  );
}

async function seedLegacyEntity(database: Client, tenantId: string): Promise<void> {
  await database.query(
    `INSERT INTO entities
       (id, tenant_id, entity_type, canonical_data, canonical_version)
     VALUES ($1, $2, 'COMPANY', $3::jsonb, 0)`,
    [legacyEntityId, tenantId, JSON.stringify({ name: 'Legacy Stored Company' })],
  );
}

async function seedForeignEntity(database: Client, tenantId: string): Promise<void> {
  await database.query(
    `INSERT INTO entities
       (id, tenant_id, entity_type, canonical_data, canonical_version)
     VALUES ($1, $2, 'PERSON', '{}'::jsonb, 0)`,
    [foreignEntityId, tenantId],
  );
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

async function insertApiKey(
  database: Client,
  tenantId: string,
  token: string,
  scopes: string[],
  revokedAt: Date | null = null,
): Promise<void> {
  await database.query(
    `INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes, revoked_at)
     VALUES ($1, 'Entity read integration key', $2, $3, $4, $5)`,
    [tenantId, token.split('.')[0], hashApiKey(token), scopes, revokedAt],
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
     VALUES ($1, $2, 'CRM', $3) RETURNING id`,
    [tenantId, name, priority],
  );
  return result.rows[0]!.id;
}
