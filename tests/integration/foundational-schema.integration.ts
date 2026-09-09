import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const prismaCli = resolve(repositoryRoot, 'node_modules/prisma/build/index.js');
const prismaConfig = resolve(repositoryRoot, 'prisma.config.ts');
const expectedTables = [
  'api_keys',
  'entities',
  'entity_record_links',
  'source_records',
  'source_systems',
  'tenants',
];
const expectedEnums = ['entity_type', 'match_decision', 'review_case_status', 'tenant_status'];
const expectedIndexes = [
  'api_keys_key_hash_key',
  'entity_record_links_tenant_entity_idx',
  'entity_record_links_tenant_record_key',
  'source_records_tenant_company_domain_idx',
  'source_records_tenant_normalized_email_idx',
  'source_records_tenant_normalized_phone_idx',
  'source_records_tenant_source_external_key',
  'source_records_tenant_type_name_prefix_idx',
  'source_systems_tenant_name_key',
];
const expectedConstraints = ['entity_record_links_score_range'];

interface DatabaseFailure extends Error {
  code?: string;
  constraint?: string;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function withoutPrismaSchema(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete('schema');
  return url.toString();
}

function withPrismaSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

async function expectDatabaseFailure(
  operation: () => Promise<unknown>,
  expected: Partial<Pick<DatabaseFailure, 'code' | 'constraint'>>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toMatchObject(expected);
    return;
  }

  throw new Error(`Expected PostgreSQL error ${expected.code} from ${expected.constraint}`);
}

describe('foundational schema migration', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = `resolve_test_${process.pid}_${Date.now()}`;
  const schemaIdentifier = quoteIdentifier(schemaName);
  const pgDatabaseUrl = withoutPrismaSchema(baseDatabaseUrl);
  const isolatedDatabaseUrl = withPrismaSchema(baseDatabaseUrl, schemaName);

  let admin: Client | undefined;
  let database: Client | undefined;

  beforeAll(async () => {
    admin = new Client({ connectionString: pgDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schemaIdentifier}`);

    const deploy = async (): Promise<void> => {
      await execFileAsync(
        process.execPath,
        [prismaCli, 'migrate', 'deploy', '--config', prismaConfig],
        {
          cwd: repositoryRoot,
          env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl },
          maxBuffer: 1024 * 1024,
        },
      );
    };

    await deploy();
    await deploy();

    database = new Client({ connectionString: pgDatabaseUrl });
    await database.connect();
    await database.query(`SET search_path TO ${schemaIdentifier}`);
  });

  afterAll(async () => {
    await database?.end();

    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaIdentifier} CASCADE`);
      await admin.end();
    }
  });

  it('creates the six foundational tables and three domain enums', async () => {
    const tables = await database!.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_type = 'BASE TABLE'
         AND table_name = ANY($2::text[])
       ORDER BY table_name`,
      [schemaName, expectedTables],
    );
    const enums = await database!.query<{ typname: string }>(
      `SELECT type.typname
       FROM pg_type AS type
       JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
       WHERE namespace.nspname = $1
         AND type.typtype = 'e'
       ORDER BY type.typname`,
      [schemaName],
    );

    expect(tables.rows.map(({ table_name }) => table_name)).toEqual(expectedTables);
    expect(enums.rows.map(({ typname }) => typname)).toEqual(expectedEnums);
  });

  it('creates named uniqueness, score, and blocking structures', async () => {
    const indexes = await database!.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1
         AND indexname = ANY($2::text[])
       ORDER BY indexname`,
      [schemaName, expectedIndexes],
    );
    const constraints = await database!.query<{ conname: string }>(
      `SELECT candidate.conname
       FROM pg_constraint AS candidate
       JOIN pg_namespace AS namespace ON namespace.oid = candidate.connamespace
       WHERE namespace.nspname = $1
         AND candidate.conname = ANY($2::text[])
       ORDER BY candidate.conname`,
      [schemaName, expectedConstraints],
    );

    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(expectedIndexes);
    expect(constraints.rows.map(({ conname }) => conname)).toEqual(expectedConstraints);
  });

  it('provides database defaults for identifiers and API key scopes', async () => {
    const tenantId = await insertTenant(database!, 'API Key Tenant');
    const result = await database!.query<{ id: string; scopes: string[] }>(
      `INSERT INTO api_keys (tenant_id, name, prefix, key_hash)
       VALUES ($1, 'Primary key', 'rslv_test_', 'hash-defaults')
       RETURNING id, scopes`,
      [tenantId],
    );

    const apiKey = result.rows[0];
    expect(apiKey).toBeDefined();
    expect(apiKey?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(apiKey?.scopes).toEqual([]);

    await expectDatabaseFailure(
      () =>
        database!.query(
          `INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes)
           VALUES ($1, 'Invalid key', 'rslv_test_', 'hash-null-scopes', NULL)`,
          [tenantId],
        ),
      { code: '23502' },
    );
  });

  it('rejects a duplicate source record while allowing tenant-local reuse', async () => {
    const tenantA = await insertTenant(database!, 'Tenant A');
    const tenantB = await insertTenant(database!, 'Tenant B');
    const sourceA = await insertSource(database!, tenantA, 'crm');
    const sourceB = await insertSource(database!, tenantB, 'crm');

    await insertRecord(database!, tenantA, sourceA, 'contact-1');
    await insertRecord(database!, tenantB, sourceB, 'contact-1');

    await expectDatabaseFailure(() => insertRecord(database!, tenantA, sourceA, 'contact-1'), {
      code: '23505',
      constraint: 'source_records_tenant_source_external_key',
    });
  });

  it('rejects a source record that references another tenant source', async () => {
    const tenantA = await insertTenant(database!, 'Source Owner');
    const tenantB = await insertTenant(database!, 'Record Owner');
    const sourceA = await insertSource(database!, tenantA, 'billing');

    await expectDatabaseFailure(() => insertRecord(database!, tenantB, sourceA, 'invoice-1'), {
      code: '23503',
      constraint: 'source_records_tenant_source_system_fkey',
    });
  });

  it('enforces tenant-safe links and the inclusive score range', async () => {
    const tenantA = await insertTenant(database!, 'Link Tenant A');
    const tenantB = await insertTenant(database!, 'Link Tenant B');
    const sourceA = await insertSource(database!, tenantA, 'csv');
    const recordA = await insertRecord(database!, tenantA, sourceA, 'row-1');
    const entityA = await insertEntity(database!, tenantA);
    const entityB = await insertEntity(database!, tenantB);

    await insertLink(database!, tenantA, entityA, recordA, '0.7500');

    const crossTenantRecord = await insertRecord(database!, tenantA, sourceA, 'row-cross-tenant');
    await expectDatabaseFailure(
      () => insertLink(database!, tenantA, entityB, crossTenantRecord, '0.8000'),
      {
        code: '23503',
        constraint: 'entity_record_links_tenant_entity_fkey',
      },
    );

    const lowRecord = await insertRecord(database!, tenantA, sourceA, 'row-low');
    await expectDatabaseFailure(
      () => insertLink(database!, tenantA, entityA, lowRecord, '-0.0001'),
      {
        code: '23514',
        constraint: 'entity_record_links_score_range',
      },
    );

    const highRecord = await insertRecord(database!, tenantA, sourceA, 'row-high');
    await expectDatabaseFailure(
      () => insertLink(database!, tenantA, entityA, highRecord, '1.0001'),
      {
        code: '23514',
        constraint: 'entity_record_links_score_range',
      },
    );
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
    'INSERT INTO source_systems (tenant_id, name, type) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, name, 'api'],
  );
  return result.rows[0]!.id;
}

async function insertRecord(
  database: Client,
  tenantId: string,
  sourceSystemId: string,
  externalId: string,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO source_records
       (tenant_id, source_system_id, external_id, entity_type, raw_payload)
     VALUES ($1, $2, $3, 'PERSON', $4::jsonb)
     RETURNING id`,
    [tenantId, sourceSystemId, externalId, JSON.stringify({ name: 'Test Person' })],
  );
  return result.rows[0]!.id;
}

async function insertEntity(database: Client, tenantId: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO entities (tenant_id, entity_type)
     VALUES ($1, 'PERSON')
     RETURNING id`,
    [tenantId],
  );
  return result.rows[0]!.id;
}

async function insertLink(
  database: Client,
  tenantId: string,
  entityId: string,
  sourceRecordId: string,
  score: string,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO entity_record_links
       (tenant_id, entity_id, source_record_id, score, decision, algorithm_version)
     VALUES ($1, $2, $3, $4, 'AUTO_MATCH', 'rules-0.1.0')
     RETURNING id`,
    [tenantId, entityId, sourceRecordId, score],
  );
  return result.rows[0]!.id;
}
