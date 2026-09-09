import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';
import request from 'supertest';

import type { ResolveApplication } from '../../apps/api/src/application.js';
import { hashApiKey } from '../../apps/api/src/auth/api-key.js';
import { CandidateGenerationService } from '../../apps/api/src/blocking/candidate-generation.service.js';
import { CandidateSourceRecordNotFoundError } from '../../apps/api/src/blocking/candidate-source-record-not-found.error.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const prismaCli = resolve(repositoryRoot, 'node_modules/prisma/build/index.js');
const prismaConfig = resolve(repositoryRoot, 'prisma.config.ts');
const tenantAToken = 'rslv_test_777777777777.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const tenantBToken = 'rslv_test_888888888888.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const originalEnvironment = {
  API_PORT: process.env.API_PORT,
  BLOCKING_MAX_CANDIDATES: process.env.BLOCKING_MAX_CANDIDATES,
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  REDIS_HOST: process.env.REDIS_HOST,
  REDIS_PORT: process.env.REDIS_PORT,
  REQUEST_BODY_LIMIT: process.env.REQUEST_BODY_LIMIT,
};

interface SourceFixture {
  name: string;
  type: string;
}

interface RecordRequest {
  source: string;
  external_id: string;
  entity_type: 'person' | 'company';
  data: Record<string, unknown>;
}

interface RecordFixture {
  idempotency_key: string;
  request: RecordRequest;
  expected_normalized: Record<string, unknown>;
}

interface CrossTenantRecordFixture {
  idempotency_key: string;
  request: RecordRequest;
}

interface Day7Fixture {
  version: string;
  tenant_a: {
    sources: SourceFixture[];
    records: RecordFixture[];
  };
  tenant_b: {
    sources: SourceFixture[];
    record: CrossTenantRecordFixture;
  };
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

interface StoredRecordRow {
  company_domain: string | null;
  current_version: number;
  external_id: string;
  normalization_version: string | null;
  normalized_email: string | null;
  normalized_name_prefix: string | null;
  normalized_payload: Record<string, unknown> | null;
  normalized_phone: string | null;
  raw_payload: Record<string, unknown>;
  source_name: string;
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/day7-integration-records.json', import.meta.url), 'utf8'),
) as Day7Fixture;

function databaseUrlForSchema(databaseUrl: string, schema?: string): string {
  const url = new URL(databaseUrl);
  if (schema) url.searchParams.set('schema', schema);
  else url.searchParams.delete('schema');
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return '"' + identifier.replaceAll('"', '""') + '"';
}

function bodyOf<T>(response: request.Response): T {
  return response.body as T;
}

describe('Day 7 integration checkpoint', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = 'resolve_day7_checkpoint_' + process.pid + '_' + Date.now();
  const adminUrl = databaseUrlForSchema(baseDatabaseUrl);
  const isolatedUrl = databaseUrlForSchema(baseDatabaseUrl, schemaName);
  const initialResponses = new Map<string, RecordResponseBody>();

  let admin: Client;
  let database: Client;
  let app: ResolveApplication;
  let candidateGeneration: CandidateGenerationService;
  let tenantA: string;
  let tenantB: string;
  let tenantAEntity: string;
  let tenantBRecord: RecordResponseBody;

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

    process.env.API_PORT = '3000';
    process.env.BLOCKING_MAX_CANDIDATES = '5';
    process.env.DATABASE_URL = isolatedUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.REQUEST_BODY_LIMIT = '1mb';

    database = new Client({ connectionString: adminUrl });
    await database.connect();
    await database.query('SET search_path TO ' + quoteIdentifier(schemaName));
    tenantA = await insertTenant(database, 'Day 7 Primary Tenant');
    tenantB = await insertTenant(database, 'Day 7 Isolated Tenant');
    await insertApiKey(database, tenantA, tenantAToken);
    await insertApiKey(database, tenantB, tenantBToken);

    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    candidateGeneration = app.get(CandidateGenerationService);

    await registerSources(app, tenantAToken, fixture.tenant_a.sources);
    await registerSources(app, tenantBToken, fixture.tenant_b.sources);

    for (const sample of fixture.tenant_a.records) {
      const response = await ingest(app, tenantAToken, sample.idempotency_key, sample.request);
      initialResponses.set(sample.idempotency_key, response);
    }
    tenantBRecord = await ingest(
      app,
      tenantBToken,
      fixture.tenant_b.record.idempotency_key,
      fixture.tenant_b.record.request,
    );

    const crmRecord = responseFor(sourceFixture('crm'));
    tenantAEntity = await insertCanonicalFixture(database, tenantA, crmRecord.record_id);
    await insertCanonicalFixture(database, tenantB, tenantBRecord.record_id);
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

  it('registers the CRM, billing, and CSV source systems through the API', async () => {
    const result = await database.query<{ name: string; type: string }>(
      'SELECT name, type FROM source_systems WHERE tenant_id = $1 ORDER BY name',
      [tenantA],
    );

    expect(result.rows).toEqual([
      { name: 'billing', type: 'billing' },
      { name: 'crm', type: 'crm' },
      { name: 'csv_import', type: 'csv' },
    ]);
  });

  it('preserves every raw source value and stores literal normalized projections', async () => {
    const stored = await database.query<StoredRecordRow>(
      `SELECT source.name AS source_name, record.external_id, record.raw_payload,
              record.normalized_payload, record.normalization_version,
              record.normalized_email, record.normalized_phone,
              record.company_domain, record.normalized_name_prefix,
              record.current_version
       FROM source_records AS record
       JOIN source_systems AS source
         ON source.tenant_id = record.tenant_id
        AND source.id = record.source_system_id
       WHERE record.tenant_id = $1
       ORDER BY source.name`,
      [tenantA],
    );

    expect(stored.rows).toEqual(
      ['billing', 'crm', 'csv_import'].map((sourceName) => {
        const sample = sourceFixture(sourceName);
        return {
          source_name: sourceName,
          external_id: sample.request.external_id,
          raw_payload: sample.request.data,
          normalized_payload: sample.expected_normalized,
          normalization_version: 'normalization-v1',
          normalized_email: 'abdul@example.com',
          normalized_phone: '+251911223344',
          company_domain: 'resolve.example',
          normalized_name_prefix: 'abdulkerim hassen',
          current_version: 1,
        };
      }),
    );

    const versions = await database.query<{
      source_name: string;
      version: number;
      raw_payload: Record<string, unknown>;
    }>(
      `SELECT source.name AS source_name, version.version, version.raw_payload
       FROM source_record_versions AS version
       JOIN source_records AS record
         ON record.tenant_id = version.tenant_id
        AND record.id = version.source_record_id
       JOIN source_systems AS source
         ON source.tenant_id = record.tenant_id
        AND source.id = record.source_system_id
       WHERE version.tenant_id = $1
       ORDER BY source.name`,
      [tenantA],
    );
    expect(versions.rows).toEqual(
      ['billing', 'crm', 'csv_import'].map((sourceName) => ({
        source_name: sourceName,
        version: 1,
        raw_payload: sourceFixture(sourceName).request.data,
      })),
    );
  });

  it('replays each request without adding records, versions, or ledger rows', async () => {
    const timestampsBefore = await recordTimestamps(database, tenantA);

    for (const sample of fixture.tenant_a.records) {
      const response = await request(app.getHttpServer() as Server)
        .post('/v1/records')
        .set('Authorization', 'Bearer ' + tenantAToken)
        .set('Idempotency-Key', sample.idempotency_key)
        .send(sample.request)
        .expect(201);
      expect(response.headers['idempotency-replayed']).toBe('true');
      expect(bodyOf<RecordResponseBody>(response)).toEqual(
        initialResponses.get(sample.idempotency_key),
      );
    }

    const counts = await database.query<{
      idempotency_requests: string;
      records: string;
      versions: string;
    }>(
      `SELECT
         (SELECT count(*) FROM idempotency_requests WHERE tenant_id = $1)
           AS idempotency_requests,
         (SELECT count(*) FROM source_records WHERE tenant_id = $1) AS records,
         (SELECT count(*) FROM source_record_versions WHERE tenant_id = $1) AS versions`,
      [tenantA],
    );
    expect(counts.rows[0]).toEqual({
      idempotency_requests: '3',
      records: '3',
      versions: '3',
    });
    expect(await recordTimestamps(database, tenantA)).toEqual(timestampsBefore);
  });

  it('keeps identical source identities and matching signals isolated by tenant', async () => {
    const records = await database.query<{ id: string; tenant_id: string }>(
      `SELECT record.id, record.tenant_id
       FROM source_records AS record
       JOIN source_systems AS source
         ON source.tenant_id = record.tenant_id
        AND source.id = record.source_system_id
       WHERE source.name = 'crm' AND record.external_id = 'person-001'
       ORDER BY record.tenant_id`,
    );

    expect(records.rows).toHaveLength(2);
    expect(new Set(records.rows.map(({ tenant_id }) => tenant_id))).toEqual(
      new Set([tenantA, tenantB]),
    );
    expect(new Set(records.rows.map(({ id }) => id)).size).toBe(2);
    await expect(
      candidateGeneration.findCandidates(tenantA, tenantBRecord.record_id),
    ).rejects.toBeInstanceOf(CandidateSourceRecordNotFoundError);
  });

  it('returns one small tenant-local candidate set for billing and CSV records', async () => {
    const crmRecord = responseFor(sourceFixture('crm'));
    const expected = {
      blockingVersion: 'blocking-v1',
      candidates: [
        {
          entityId: tenantAEntity,
          entityType: 'PERSON',
          matchedOn: ['EXACT_EMAIL', 'EXACT_PHONE', 'COMPANY_DOMAIN', 'NAME_LOCATION'],
          supportingRecordIds: [crmRecord.record_id],
        },
      ],
      truncated: false,
    };

    await expect(
      candidateGeneration.findCandidates(tenantA, responseFor(sourceFixture('billing')).record_id),
    ).resolves.toEqual(expected);
    await expect(
      candidateGeneration.findCandidates(
        tenantA,
        responseFor(sourceFixture('csv_import')).record_id,
      ),
    ).resolves.toEqual(expected);
    await expect(candidateGeneration.findCandidates(tenantA, crmRecord.record_id)).resolves.toEqual(
      {
        blockingVersion: 'blocking-v1',
        candidates: [],
        truncated: false,
      },
    );
  });

  function sourceFixture(sourceName: string): RecordFixture {
    const sample = fixture.tenant_a.records.find(
      ({ request: record }) => record.source === sourceName,
    );
    if (!sample) throw new Error('Missing Day 7 fixture for source: ' + sourceName);
    return sample;
  }

  function responseFor(sample: RecordFixture): RecordResponseBody {
    const response = initialResponses.get(sample.idempotency_key);
    if (!response) throw new Error('Missing initial response for: ' + sample.idempotency_key);
    return response;
  }
});

async function registerSources(
  app: ResolveApplication,
  token: string,
  sources: SourceFixture[],
): Promise<void> {
  for (const source of sources) {
    await request(app.getHttpServer() as Server)
      .post('/v1/sources')
      .set('Authorization', 'Bearer ' + token)
      .send(source)
      .expect(201);
  }
}

async function ingest(
  app: ResolveApplication,
  token: string,
  idempotencyKey: string,
  input: RecordRequest,
): Promise<RecordResponseBody> {
  const response = await request(app.getHttpServer() as Server)
    .post('/v1/records')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', idempotencyKey)
    .send(input)
    .expect(201);
  return bodyOf<RecordResponseBody>(response);
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
     VALUES ($1, 'Day 7 integration key', $2, $3, $4)`,
    [tenantId, token.split('.')[0], hashApiKey(token), ['sources:write', 'records:write']],
  );
}

async function insertCanonicalFixture(
  database: Client,
  tenantId: string,
  sourceRecordId: string,
): Promise<string> {
  const entity = await database.query<{ id: string }>(
    `INSERT INTO entities (tenant_id, entity_type, canonical_data)
     VALUES ($1, 'PERSON', '{}'::jsonb)
     RETURNING id`,
    [tenantId],
  );
  const entityId = entity.rows[0]!.id;
  await database.query(
    `INSERT INTO entity_record_links
       (tenant_id, entity_id, source_record_id, score, decision, algorithm_version)
     VALUES ($1, $2, $3, 1, 'AUTO_MATCH', 'day7-fixture-v1')`,
    [tenantId, entityId, sourceRecordId],
  );
  return entityId;
}

async function recordTimestamps(
  database: Client,
  tenantId: string,
): Promise<Array<{ id: string; updated_at: Date }>> {
  const result = await database.query<{ id: string; updated_at: Date }>(
    'SELECT id, updated_at FROM source_records WHERE tenant_id = $1 ORDER BY id',
    [tenantId],
  );
  return result.rows;
}
