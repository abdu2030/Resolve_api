import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const prismaCli = resolve(repositoryRoot, 'node_modules/prisma/build/index.js');
const prismaConfig = resolve(repositoryRoot, 'prisma.config.ts');

interface DatabaseFailure extends Error {
  code?: string;
  constraint?: string;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseUrlForSchema(databaseUrl: string, schema?: string): string {
  const url = new URL(databaseUrl);
  if (schema) url.searchParams.set('schema', schema);
  else url.searchParams.delete('schema');
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

describe('Day 4 authentication and ingestion schema', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = `resolve_day4_${process.pid}_${Date.now()}`;
  const pgDatabaseUrl = databaseUrlForSchema(baseDatabaseUrl);
  const isolatedDatabaseUrl = databaseUrlForSchema(baseDatabaseUrl, schemaName);
  let admin: Client | undefined;
  let database: Client | undefined;

  beforeAll(async () => {
    admin = new Client({ connectionString: pgDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await execFileAsync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--config', prismaConfig],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl },
        maxBuffer: 1024 * 1024,
      },
    );
    database = new Client({ connectionString: pgDatabaseUrl });
    await database.connect();
    await database.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
  });

  afterAll(async () => {
    await database?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await admin.end();
    }
  });

  it('creates version history and idempotency ledger structures', async () => {
    const tables = await database!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = ANY($2::text[])
       ORDER BY table_name`,
      [schemaName, ['idempotency_requests', 'source_record_versions']],
    );
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      'idempotency_requests',
      'source_record_versions',
    ]);

    const indexes = await database!.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND indexname = ANY($2::text[])
       ORDER BY indexname`,
      [
        schemaName,
        [
          'idempotency_requests_tenant_created_idx',
          'idempotency_requests_tenant_key_key',
          'source_record_versions_tenant_record_version_key',
        ],
      ],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      'idempotency_requests_tenant_created_idx',
      'idempotency_requests_tenant_key_key',
      'source_record_versions_tenant_record_version_key',
    ]);
  });

  it('enforces version, hash, and response-status checks', async () => {
    const constraints = await database!.query<{ conname: string }>(
      `SELECT candidate.conname FROM pg_constraint AS candidate
       JOIN pg_namespace AS namespace ON namespace.oid = candidate.connamespace
       WHERE namespace.nspname = $1 AND candidate.conname = ANY($2::text[])
       ORDER BY candidate.conname`,
      [
        schemaName,
        [
          'idempotency_requests_response_status_range',
          'source_record_versions_payload_hash_format',
          'source_record_versions_version_positive',
          'source_records_current_version_positive',
          'source_records_raw_payload_hash_format',
        ],
      ],
    );
    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      'idempotency_requests_response_status_range',
      'source_record_versions_payload_hash_format',
      'source_record_versions_version_positive',
      'source_records_current_version_positive',
      'source_records_raw_payload_hash_format',
    ]);
  });

  it('rejects cross-tenant source record version history', async () => {
    const tenantA = await insertTenant(database!, 'Version Tenant A');
    const tenantB = await insertTenant(database!, 'Version Tenant B');
    const sourceA = await insertSource(database!, tenantA, 'crm');
    const recordA = await insertRecord(database!, tenantA, sourceA, 'contact-1');

    await expectDatabaseFailure(
      () =>
        database!.query(
          `INSERT INTO source_record_versions
             (tenant_id, source_record_id, version, raw_payload, payload_hash)
           VALUES ($1, $2, 1, $3::jsonb, $4)`,
          [tenantB, recordA, JSON.stringify({ name: 'Wrong tenant' }), 'a'.repeat(64)],
        ),
      { code: '23503', constraint: 'source_record_versions_tenant_source_record_fkey' },
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
    `INSERT INTO source_systems (tenant_id, name, type)
     VALUES ($1, $2, 'api') RETURNING id`,
    [tenantId, name],
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
     VALUES ($1, $2, $3, 'PERSON', $4::jsonb) RETURNING id`,
    [tenantId, sourceSystemId, externalId, JSON.stringify({ name: 'Test Person' })],
  );
  return result.rows[0]!.id;
}
