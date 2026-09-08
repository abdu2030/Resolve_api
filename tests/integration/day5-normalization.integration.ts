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
const recordsToken = 'rslv_test_555555555555.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  API_PORT: process.env.API_PORT,
  REDIS_HOST: process.env.REDIS_HOST,
  REDIS_PORT: process.env.REDIS_PORT,
  REQUEST_BODY_LIMIT: process.env.REQUEST_BODY_LIMIT,
};

interface RecordResponseBody {
  record_id: string;
  version: number;
  operation: 'CREATED' | 'UPDATED' | 'UNCHANGED';
}

interface StoredNormalization {
  raw_payload: Record<string, unknown>;
  normalized_payload: Record<string, unknown> | null;
  normalization_version: string | null;
  normalized_email: string | null;
  normalized_phone: string | null;
  company_domain: string | null;
  normalized_name_prefix: string | null;
  current_version: number;
  updated_at: Date;
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
  return '"' + identifier.replaceAll('"', '""') + '"';
}

describe('Day 5 normalization persistence', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = 'resolve_day5_normalization_' + process.pid + '_' + Date.now();
  const adminUrl = databaseUrlForSchema(baseDatabaseUrl);
  const isolatedUrl = databaseUrlForSchema(baseDatabaseUrl, schemaName);
  let admin: Client;
  let database: Client;
  let app: ResolveApplication;

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

    process.env.DATABASE_URL = isolatedUrl;
    process.env.NODE_ENV = 'test';
    process.env.API_PORT = '3000';
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.REQUEST_BODY_LIMIT = '1mb';

    database = new Client({ connectionString: adminUrl });
    await database.connect();
    await database.query('SET search_path TO ' + quoteIdentifier(schemaName));
    const tenantId = await insertTenant(database, 'Day 5 Tenant');
    await insertApiKey(database, tenantId, recordsToken, ['records:write']);
    await insertSource(database, tenantId, 'normalization');

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

  it('stores raw Person source truth and separate normalized projections', async () => {
    const rawData = {
      name: '  José   李 ',
      email: 'User+tag@EXAMPLE.COM',
      phone: '0911 223 344',
      company: ' ACME Trading PLC ',
      company_domain: 'WWW.ACME.EXAMPLE.',
      address: { city: ' Addis   Ababa ', country: 'et' },
      attributes: { source_rank: 1 },
    };
    const response = await ingest(app, {
      source: 'normalization',
      external_id: 'person-create',
      entity_type: 'person',
      data: rawData,
    }).expect(201);
    const body = bodyOf<RecordResponseBody>(response);

    const stored = await loadRecord(database, body.record_id);
    const { updated_at: updatedAt, ...storedValues } = stored;
    expect(updatedAt).toBeInstanceOf(Date);
    expect(storedValues).toEqual({
      raw_payload: rawData,
      normalized_payload: {
        name: 'josé 李',
        email: 'User+tag@example.com',
        phone: '+251911223344',
        company: {
          full: 'acme trading plc',
          base: 'acme trading',
          legal_suffix: 'plc',
        },
        company_domain: 'acme.example',
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
      normalized_email: 'User+tag@example.com',
      normalized_phone: '+251911223344',
      company_domain: 'acme.example',
      normalized_name_prefix: 'josé 李',
      current_version: 1,
    });
    const history = await database.query<{ version: number; raw_payload: object }>(
      'SELECT version, raw_payload FROM source_record_versions WHERE source_record_id = $1',
      [body.record_id],
    );
    expect(history.rows).toEqual([{ version: 1, raw_payload: rawData }]);
  });

  it('creates immutable raw history and recomputes normalization when raw data changes', async () => {
    const initial = {
      source: 'normalization',
      external_id: 'person-update',
      entity_type: 'person',
      data: { name: ' ORIGINAL NAME ', email: 'First@EXAMPLE.COM' },
    };
    const created = await ingest(app, initial).expect(201);
    const createdBody = bodyOf<RecordResponseBody>(created);

    const changedData = {
      name: ' Updated   Name ',
      email: 'Second+tag@EXAMPLE.COM',
      phone: '+251 911 223 344',
    };
    const updated = await ingest(app, { ...initial, data: changedData }).expect(200);
    expect(bodyOf<RecordResponseBody>(updated)).toMatchObject({
      record_id: createdBody.record_id,
      version: 2,
      operation: 'UPDATED',
    });

    const stored = await loadRecord(database, createdBody.record_id);
    expect(stored).toMatchObject({
      raw_payload: changedData,
      normalized_payload: {
        name: 'updated name',
        email: 'Second+tag@example.com',
        phone: '+251911223344',
      },
      normalization_version: 'normalization-v1',
      normalized_email: 'Second+tag@example.com',
      normalized_phone: '+251911223344',
      normalized_name_prefix: 'updated name',
      current_version: 2,
    });
    const history = await database.query<{ version: number; raw_payload: object }>(
      'SELECT version, raw_payload FROM source_record_versions ' +
        'WHERE source_record_id = $1 ORDER BY version',
      [createdBody.record_id],
    );
    expect(history.rows).toEqual([
      { version: 1, raw_payload: initial.data },
      { version: 2, raw_payload: changedData },
    ]);
  });

  it('performs no write for unchanged raw data already on the current normalization version', async () => {
    const payload = {
      source: 'normalization',
      external_id: 'person-unchanged',
      entity_type: 'person',
      data: {
        name: ' Stable Person ',
        address: { city: 'Addis Ababa', country: 'et' },
      },
    };
    const created = await ingest(app, payload).expect(201);
    const recordId = bodyOf<RecordResponseBody>(created).record_id;
    const before = await loadRecord(database, recordId);

    const unchanged = await ingest(app, {
      data: { address: { country: 'et', city: 'Addis Ababa' }, name: ' Stable Person ' },
      entity_type: 'person',
      external_id: 'person-unchanged',
      source: 'normalization',
    }).expect(200);

    expect(bodyOf<RecordResponseBody>(unchanged)).toMatchObject({
      record_id: recordId,
      version: 1,
      operation: 'UNCHANGED',
    });
    const after = await loadRecord(database, recordId);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(await versionCount(database, recordId)).toBe('1');
  });

  it('refreshes missing derived fields without changing raw data or raw history', async () => {
    const payload = {
      source: 'normalization',
      external_id: 'person-refresh',
      entity_type: 'person',
      data: { name: ' Refresh Person ', email: 'Refresh@EXAMPLE.COM' },
    };
    const created = await ingest(app, payload).expect(201);
    const recordId = bodyOf<RecordResponseBody>(created).record_id;
    await database.query(
      'UPDATE source_records SET normalized_payload = NULL, normalization_version = NULL, ' +
        'normalized_email = NULL, normalized_phone = NULL, company_domain = NULL, ' +
        'normalized_name_prefix = NULL WHERE id = $1',
      [recordId],
    );

    const refreshed = await ingest(app, payload).expect(200);
    expect(bodyOf<RecordResponseBody>(refreshed)).toMatchObject({
      record_id: recordId,
      version: 1,
      operation: 'UNCHANGED',
    });
    const stored = await loadRecord(database, recordId);
    expect(stored).toMatchObject({
      raw_payload: payload.data,
      normalized_payload: {
        name: 'refresh person',
        email: 'Refresh@example.com',
      },
      normalization_version: 'normalization-v1',
      normalized_email: 'Refresh@example.com',
      normalized_name_prefix: 'refresh person',
      current_version: 1,
    });
    expect(await versionCount(database, recordId)).toBe('1');
  });

  it('maps Company domain and address-country phone context to projections', async () => {
    const response = await ingest(app, {
      source: 'normalization',
      external_id: 'company-create',
      entity_type: 'company',
      data: {
        name: ' Resolve Incorporated ',
        domain: 'HTTPS://WWW.RESOLVE.EXAMPLE/',
        phone: '0911 223 344',
        registration_id: ' RAW-123 ',
        address: { country: 'et' },
      },
    }).expect(201);
    const stored = await loadRecord(database, bodyOf<RecordResponseBody>(response).record_id);

    expect(stored).toMatchObject({
      normalized_payload: {
        name: {
          full: 'resolve incorporated',
          base: 'resolve',
          legal_suffix: 'incorporated',
        },
        domain: 'resolve.example',
        email: null,
        phone: '+251911223344',
        address: {
          line1: null,
          line2: null,
          city: null,
          region: null,
          postal_code: null,
          country: 'ET',
        },
      },
      normalization_version: 'normalization-v1',
      normalized_phone: '+251911223344',
      company_domain: 'resolve.example',
      normalized_name_prefix: 'resolve incorporated',
    });
    expect(stored.normalized_payload).not.toHaveProperty('registration_id');
  });
});

function ingest(app: ResolveApplication, payload: Record<string, unknown>): request.Test {
  return request(app.getHttpServer() as Server)
    .post('/v1/records')
    .set('Authorization', 'Bearer ' + recordsToken)
    .send(payload);
}

async function loadRecord(database: Client, recordId: string): Promise<StoredNormalization> {
  const result = await database.query<StoredNormalization>(
    'SELECT raw_payload, normalized_payload, normalization_version, ' +
      'normalized_email, normalized_phone, company_domain, normalized_name_prefix, ' +
      'current_version, updated_at FROM source_records WHERE id = $1',
    [recordId],
  );
  return result.rows[0]!;
}

async function versionCount(database: Client, recordId: string): Promise<string> {
  const result = await database.query<{ count: string }>(
    'SELECT count(*) FROM source_record_versions WHERE source_record_id = $1',
    [recordId],
  );
  return result.rows[0]!.count;
}

async function insertTenant(database: Client, name: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [name],
  );
  return result.rows[0]!.id;
}

async function insertSource(database: Client, tenantId: string, name: string): Promise<void> {
  await database.query(
    "INSERT INTO source_systems (tenant_id, name, type) VALUES ($1, $2, 'api')",
    [tenantId, name],
  );
}

async function insertApiKey(
  database: Client,
  tenantId: string,
  token: string,
  scopes: string[],
): Promise<void> {
  await database.query(
    'INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes) ' +
      "VALUES ($1, 'Day 5 key', $2, $3, $4)",
    [tenantId, token.split('.')[0], hashApiKey(token), scopes],
  );
}
