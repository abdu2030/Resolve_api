import type { Server } from 'node:http';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';
import request from 'supertest';

import type { ResolveApplication } from '../../apps/api/src/application.js';
import { hashApiKey } from '../../apps/api/src/auth/api-key.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const prismaCli = resolve(repositoryRoot, 'node_modules/prisma/build/index.js');
const prismaConfig = resolve(repositoryRoot, 'prisma.config.ts');
const fullToken = 'rslv_test_111111111111.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const recordsToken = 'rslv_test_222222222222.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  API_PORT: process.env.API_PORT,
  REDIS_HOST: process.env.REDIS_HOST,
  REDIS_PORT: process.env.REDIS_PORT,
  REQUEST_BODY_LIMIT: process.env.REQUEST_BODY_LIMIT,
};
const otherToken = 'rslv_test_333333333333.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const sourcesToken = 'rslv_test_444444444444.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';

interface SourceResponseBody {
  source_id: string;
  name: string;
  type: string;
  created_at: string;
}

interface RecordResponseBody {
  record_id: string;
  source_id: string;
  external_id: string;
  entity_type: 'person' | 'company';
  version: number;
  status: 'STORED';
  operation: 'CREATED' | 'UPDATED' | 'UNCHANGED';
  created_at: string;
  updated_at: string;
}

interface OpenApiOperation {
  security: Array<Record<string, unknown>>;
  parameters: unknown[];
  requestBody: { content: { 'application/json': { schema: object } } };
  responses: Record<string, unknown>;
}

interface Day4OpenApiDocument {
  paths: {
    '/v1/sources': { post: OpenApiOperation };
    '/v1/records': { post: OpenApiOperation };
  };
}

function bodyOf<T>(response: request.Response): T {
  return response.body as T;
}
function databaseUrlForSchema(databaseUrl: string, schema?: string): string {
  const url = new URL(databaseUrl);
  if (schema) url.searchParams.set('schema', schema);
  else url.searchParams.delete('schema');
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

describe('Day 4 API', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = `resolve_day4_api_${process.pid}_${Date.now()}`;
  const adminUrl = databaseUrlForSchema(baseDatabaseUrl);
  const isolatedUrl = databaseUrlForSchema(baseDatabaseUrl, schemaName);
  let admin: Client;
  let database: Client;
  let app: ResolveApplication;

  let tenantId: string;
  let otherTenantId: string;
  let ingestionSourceId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await execFileAsync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--config', prismaConfig],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DATABASE_URL: isolatedUrl },
        maxBuffer: 1024 * 1024,
      },
    );

    process.env.DATABASE_URL = isolatedUrl;
    process.env.NODE_ENV = 'test';
    process.env.API_PORT = '3000';
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.REQUEST_BODY_LIMIT = '1mb';

    database = new Client({ connectionString: adminUrl });
    await database.connect();
    await database.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    tenantId = await insertTenant(database, 'Day 4 Tenant');
    otherTenantId = await insertTenant(database, 'Other Tenant');
    await insertApiKey(database, tenantId, fullToken, ['sources:write', 'records:write']);
    await insertApiKey(database, tenantId, recordsToken, ['records:write']);
    await insertApiKey(database, tenantId, sourcesToken, ['sources:write']);
    await insertApiKey(database, otherTenantId, otherToken, ['sources:write', 'records:write']);
    ingestionSourceId = await insertSource(database, tenantId, 'ingestion');
    await insertSource(database, otherTenantId, 'private');

    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await database?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await admin.end();
    }
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('publishes the Day 4 bearer-authenticated OpenAPI contract', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/docs-json')
      .expect(200);
    const document = bodyOf<Day4OpenApiDocument>(response);
    const sources = document.paths['/v1/sources'].post;
    const records = document.paths['/v1/records'].post;

    expect(sources.security).toEqual([{ 'api-key': [] }]);
    expect(sources.requestBody.content['application/json'].schema).toMatchObject({
      type: 'object',
      required: ['name', 'type'],
      properties: { name: { type: 'string' }, type: { type: 'string' } },
    });
    expect(Object.keys(sources.responses)).toEqual(
      expect.arrayContaining(['200', '201', '401', '403', '409']),
    );
    expect(records.security).toEqual([{ 'api-key': [] }]);
    expect(records.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'header', name: 'Idempotency-Key', required: false }),
      ]),
    );
    expect(records.requestBody.content['application/json'].schema).toMatchObject({
      type: 'object',
      required: ['source', 'external_id', 'entity_type', 'data'],
    });
    expect(Object.keys(records.responses)).toEqual(
      expect.arrayContaining(['200', '201', '400', '401', '403', '404', '409']),
    );
  });
  it('protects source registration with authentication and scope checks', async () => {
    await request(app.getHttpServer() as Server)
      .post('/v1/sources')
      .send({ name: 'crm', type: 'api' })
      .expect(401);
    await request(app.getHttpServer() as Server)
      .post('/v1/sources')
      .set('Authorization', `Bearer ${recordsToken}`)
      .send({ name: 'crm', type: 'api' })
      .expect(403);
  });

  it('creates a source once and replays the same registration', async () => {
    const created = await request(app.getHttpServer() as Server)
      .post('/v1/sources')
      .set('Authorization', `Bearer ${fullToken}`)
      .send({ name: 'crm', type: 'api' })
      .expect(201);
    const createdBody = bodyOf<SourceResponseBody>(created);
    expect(createdBody).toMatchObject({ name: 'crm', type: 'api' });
    expect(createdBody.source_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(createdBody.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const replayed = await request(app.getHttpServer() as Server)
      .post('/v1/sources')
      .set('Authorization', `Bearer ${fullToken}`)
      .send({ name: 'crm', type: 'api' })
      .expect(200);
    expect(bodyOf<SourceResponseBody>(replayed)).toEqual(createdBody);
  });

  it('rejects reusing a tenant source name with a different type', async () => {
    await request(app.getHttpServer() as Server)
      .post('/v1/sources')
      .set('Authorization', `Bearer ${fullToken}`)
      .send({ name: 'crm', type: 'csv' })
      .expect(409, {
        error: {
          code: 'SOURCE_TYPE_CONFLICT',
          message: 'A source with this name already exists with a different type',
        },
      });
  });

  it('allows another tenant to use the same source name', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/v1/sources')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'crm', type: 'api' })
      .expect(201);
    const tenantSource = await database.query<{ id: string }>(
      'SELECT id FROM source_systems WHERE tenant_id = $1 AND name = $2',
      [tenantId, 'crm'],
    );
    expect(bodyOf<SourceResponseBody>(response).source_id).not.toBe(tenantSource.rows[0]!.id);
  });

  it('serializes concurrent identical source registrations into one row', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app.getHttpServer() as Server)
          .post('/v1/sources')
          .set('Authorization', `Bearer ${fullToken}`)
          .send({ name: 'billing', type: 'api' }),
      ),
    );
    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(9);
    expect(new Set(responses.map((item) => bodyOf<SourceResponseBody>(item).source_id)).size).toBe(
      1,
    );
    const count = await database.query<{ count: string }>(
      'SELECT count(*) FROM source_systems WHERE tenant_id = $1 AND name = $2',
      [tenantId, 'billing'],
    );
    expect(count.rows[0]!.count).toBe('1');
  });

  it('protects record ingestion and validates its nested contract', async () => {
    const valid = {
      source: 'ingestion',
      external_id: 'scope-check',
      entity_type: 'person',
      data: { name: 'Scope Check' },
    };
    await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .send(valid)
      .expect(401);
    await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${sourcesToken}`)
      .send(valid)
      .expect(403);
    await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${recordsToken}`)
      .send({ ...valid, data: { name: 'Scope Check', tenant_id: tenantId } })
      .expect(400);
  });

  it('does not resolve a source that belongs to another tenant', async () => {
    await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${recordsToken}`)
      .send({
        source: 'private',
        external_id: 'private-1',
        entity_type: 'person',
        data: { name: 'Tenant Boundary' },
      })
      .expect(404, {
        error: { code: 'SOURCE_NOT_FOUND', message: 'Source does not exist' },
      });
  });

  it('stores the original payload and creates immutable version one', async () => {
    const raw =
      '{"source":"ingestion","external_id":"raw-1","entity_type":"person","data":{"name":"Abdulkerim Hassen","address":{"country":"et","city":"Addis Ababa"}}}';
    const response = await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${recordsToken}`)
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(201);
    const body = bodyOf<RecordResponseBody>(response);
    expect(body).toMatchObject({
      source_id: ingestionSourceId,
      external_id: 'raw-1',
      entity_type: 'person',
      version: 1,
      status: 'STORED',
      operation: 'CREATED',
    });

    const stored = await database.query<{
      raw_payload: { address: { country: string } };
      current_version: number;
    }>('SELECT raw_payload, current_version FROM source_records WHERE id = $1', [body.record_id]);
    expect(stored.rows[0]).toMatchObject({
      raw_payload: { address: { country: 'et' } },
      current_version: 1,
    });
    const versions = await database.query<{ version: number; raw_payload: object }>(
      'SELECT version, raw_payload FROM source_record_versions WHERE source_record_id = $1',
      [body.record_id],
    );
    expect(versions.rows).toEqual([
      {
        version: 1,
        raw_payload: { name: 'Abdulkerim Hassen', address: { city: 'Addis Ababa', country: 'et' } },
      },
    ]);
  });

  it('returns unchanged for a property-reordered identical payload', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${recordsToken}`)
      .send({
        data: { address: { city: 'Addis Ababa', country: 'et' }, name: 'Abdulkerim Hassen' },
        entity_type: 'person',
        external_id: 'raw-1',
        source: 'ingestion',
      })
      .expect(200);
    const body = bodyOf<RecordResponseBody>(response);
    expect(body).toMatchObject({ version: 1, operation: 'UNCHANGED' });
    const count = await database.query<{ count: string }>(
      'SELECT count(*) FROM source_record_versions WHERE source_record_id = $1',
      [body.record_id],
    );
    expect(count.rows[0]!.count).toBe('1');
  });

  it('adds an immutable version when the payload changes', async () => {
    await database.query(
      `UPDATE source_records SET normalized_payload = '{"name":"derived"}'::jsonb,
       normalization_version = 'normalization-v1' WHERE external_id = 'raw-1'`,
    );
    const response = await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${recordsToken}`)
      .send({
        source: 'ingestion',
        external_id: 'raw-1',
        entity_type: 'person',
        data: { name: 'Abdulkerim H.', address: { country: 'et', city: 'Addis Ababa' } },
      })
      .expect(200);
    const body = bodyOf<RecordResponseBody>(response);
    expect(body).toMatchObject({ version: 2, operation: 'UPDATED' });
    const history = await database.query<{ version: number; name: string }>(
      `SELECT version, raw_payload->>'name' AS name FROM source_record_versions
       WHERE source_record_id = $1 ORDER BY version`,
      [body.record_id],
    );
    expect(history.rows).toEqual([
      { version: 1, name: 'Abdulkerim Hassen' },
      { version: 2, name: 'Abdulkerim H.' },
    ]);
    const normalized = await database.query<{
      normalized_payload: object;
      normalization_version: string;
    }>(
      `SELECT normalized_payload, normalization_version
       FROM source_records WHERE id = $1`,
      [body.record_id],
    );
    expect(normalized.rows[0]).toEqual({
      normalized_payload: {
        name: 'abdulkerim h.',
        email: null,
        phone: null,
        company: null,
        company_domain: null,
        address: {
          line1: null,
          line2: null,
          city: 'addis ababa',
          region: null,
          postal_code: null,
          country: 'ET',
        },
      },
      normalization_version: 'normalization-v1',
    });
  });

  it('rejects changing entity type without adding a version', async () => {
    await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${recordsToken}`)
      .send({
        source: 'ingestion',
        external_id: 'raw-1',
        entity_type: 'company',
        data: { name: 'Abdulkerim PLC' },
      })
      .expect(409, {
        error: {
          code: 'ENTITY_TYPE_CONFLICT',
          message: 'Entity type cannot change for a source record',
        },
      });
    const count = await database.query<{ count: string }>(
      `SELECT count(*) FROM source_record_versions AS version
       JOIN source_records AS record ON record.id = version.source_record_id
       WHERE record.external_id = 'raw-1'`,
    );
    expect(count.rows[0]!.count).toBe('2');
  });

  it('replays the stored response for the same Idempotency-Key and request', async () => {
    const payload = {
      source: 'ingestion',
      external_id: 'idem-1',
      entity_type: 'company',
      data: { name: 'Acme Trading PLC', domain: 'acme.example' },
    };
    const first = await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${recordsToken}`)
      .set('Idempotency-Key', 'record-idem-1')
      .send(payload)
      .expect(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    const replay = await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${recordsToken}`)
      .set('Idempotency-Key', 'record-idem-1')
      .send(payload)
      .expect(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(bodyOf<RecordResponseBody>(replay)).toEqual(bodyOf<RecordResponseBody>(first));
  });

  it('rejects reusing an Idempotency-Key for a different request', async () => {
    await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${recordsToken}`)
      .set('Idempotency-Key', 'record-idem-1')
      .send({
        source: 'ingestion',
        external_id: 'different',
        entity_type: 'person',
        data: { name: 'Different' },
      })
      .expect(409, {
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency-Key was already used for a different request',
        },
      });
  });

  it('rejects an invalid Idempotency-Key before writing', async () => {
    await request(app.getHttpServer() as Server)
      .post('/v1/records')
      .set('Authorization', `Bearer ${recordsToken}`)
      .set('Idempotency-Key', 'contains space')
      .send({
        source: 'ingestion',
        external_id: 'invalid-key',
        entity_type: 'person',
        data: { name: 'No Write' },
      })
      .expect(400);
    const count = await database.query<{ count: string }>(
      `SELECT count(*) FROM source_records WHERE external_id = 'invalid-key'`,
    );
    expect(count.rows[0]!.count).toBe('0');
  });

  it('serializes concurrent natural retries into one record version', async () => {
    const payload = {
      source: 'ingestion',
      external_id: 'natural-race',
      entity_type: 'person',
      data: { name: 'Concurrent Person' },
    };
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app.getHttpServer() as Server)
          .post('/v1/records')
          .set('Authorization', `Bearer ${recordsToken}`)
          .send(payload),
      ),
    );
    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(9);
    expect(new Set(responses.map((item) => bodyOf<RecordResponseBody>(item).record_id)).size).toBe(
      1,
    );
    const count = await database.query<{ records: string; versions: string }>(
      `SELECT count(DISTINCT record.id) AS records, count(version.id) AS versions
       FROM source_records AS record
       JOIN source_record_versions AS version ON version.source_record_id = record.id
       WHERE record.external_id = 'natural-race'`,
    );
    expect(count.rows[0]).toEqual({ records: '1', versions: '1' });
  });

  it('serializes concurrent explicit idempotency retries and stores one ledger row', async () => {
    const payload = {
      source: 'ingestion',
      external_id: 'key-race',
      entity_type: 'company',
      data: { name: 'Concurrent Company' },
    };
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app.getHttpServer() as Server)
          .post('/v1/records')
          .set('Authorization', `Bearer ${recordsToken}`)
          .set('Idempotency-Key', 'concurrent-key')
          .send(payload),
      ),
    );
    expect(responses.every(({ status }) => status === 201)).toBe(true);
    expect(
      responses.filter(({ headers }) => headers['idempotency-replayed'] === 'true'),
    ).toHaveLength(9);
    expect(new Set(responses.map((item) => bodyOf<RecordResponseBody>(item).record_id)).size).toBe(
      1,
    );
    const ledger = await database.query<{ count: string }>(
      `SELECT count(*) FROM idempotency_requests WHERE tenant_id = $1 AND key = 'concurrent-key'`,
      [tenantId],
    );
    expect(ledger.rows[0]!.count).toBe('1');
  });
});

async function insertTenant(database: Client, name: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [name],
  );
  return result.rows[0]!.id;
}

async function insertSource(database: Client, tenantId: string, name: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO source_systems (tenant_id, name, type) VALUES ($1, $2, 'api') RETURNING id`,
    [tenantId, name],
  );
  return result.rows[0]!.id;
}
async function insertApiKey(
  database: Client,
  tenantId: string,
  token: string,
  scopes: string[],
): Promise<void> {
  await database.query(
    `INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes)
     VALUES ($1, 'Integration key', $2, $3, $4)`,
    [tenantId, token.split('.')[0], hashApiKey(token), scopes],
  );
}
