import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const prismaCli = resolve(root, 'node_modules/prisma/build/index.js');
const prismaConfig = resolve(root, 'prisma.config.ts');

function urlForSchema(url: string, schema?: string): string {
  const value = new URL(url);
  if (schema) value.searchParams.set('schema', schema);
  else value.searchParams.delete('schema');
  return value.toString();
}

async function expectFailure(
  operation: () => Promise<unknown>,
  code: string,
  constraint: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toMatchObject({ code, constraint });
    return;
  }
  throw new Error(`Expected ${code} from ${constraint}`);
}

describe('Week 2 Day 4 canonicalization schema migration', () => {
  const baseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schema = `resolve_day4_canonical_${process.pid}_${Date.now()}`;
  let admin: Client;
  let database: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: urlForSchema(baseUrl) });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await execFileAsync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--config', prismaConfig],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: urlForSchema(baseUrl, schema) },
      },
    );
    database = new Client({ connectionString: urlForSchema(baseUrl) });
    await database.connect();
    await database.query(`SET search_path TO "${schema}"`);
  });

  afterAll(async () => {
    await database?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it('enforces source priority and tenant-safe canonical provenance history', async () => {
    const columnResult = await database.query<{
      table_name: string;
      column_name: string;
      column_default: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND (table_name, column_name) IN (('source_systems', 'priority'), ('entities', 'canonical_version'))`,
      [schema],
    );
    const columns = Object.fromEntries(
      columnResult.rows.map((row) => [
        row.column_name === 'priority' ? 'source_priority' : row.column_name,
        { column_default: row.column_default, is_nullable: row.is_nullable },
      ]),
    );
    const tables = await database.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
      [schema],
    );
    const indexes = await database.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1',
      [schema],
    );
    expect(columns).toMatchObject({
      source_priority: { column_default: '100', is_nullable: 'NO' },
      canonical_version: { column_default: '0', is_nullable: 'NO' },
    });
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual(
      expect.arrayContaining(['entity_field_provenance', 'entity_canonical_versions']),
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        'entity_field_provenance_tenant_entity_idx',
        'entity_canonical_versions_tenant_entity_version_idx',
      ]),
    );

    const tenantA = (
      await database.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('A') RETURNING id`)
    ).rows[0]!.id;
    const tenantB = (
      await database.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('B') RETURNING id`)
    ).rows[0]!.id;
    const sourceA = (
      await database.query<{ id: string }>(
        `INSERT INTO source_systems (tenant_id, name, type) VALUES ($1, 'a', 'api') RETURNING id`,
        [tenantA],
      )
    ).rows[0]!.id;
    const sourceB = (
      await database.query<{ id: string }>(
        `INSERT INTO source_systems (tenant_id, name, type) VALUES ($1, 'b', 'api') RETURNING id`,
        [tenantB],
      )
    ).rows[0]!.id;
    const recordA = (
      await database.query<{ id: string }>(
        `INSERT INTO source_records (tenant_id, source_system_id, external_id, entity_type, raw_payload) VALUES ($1, $2, 'a', 'PERSON', '{}'::jsonb) RETURNING id`,
        [tenantA, sourceA],
      )
    ).rows[0]!.id;
    const recordB = (
      await database.query<{ id: string }>(
        `INSERT INTO source_records (tenant_id, source_system_id, external_id, entity_type, raw_payload) VALUES ($1, $2, 'b', 'PERSON', '{}'::jsonb) RETURNING id`,
        [tenantB, sourceB],
      )
    ).rows[0]!.id;
    const entityA = (
      await database.query<{ id: string }>(
        `INSERT INTO entities (tenant_id, entity_type) VALUES ($1, 'PERSON') RETURNING id`,
        [tenantA],
      )
    ).rows[0]!.id;
    const entityB = (
      await database.query<{ id: string }>(
        `INSERT INTO entities (tenant_id, entity_type) VALUES ($1, 'PERSON') RETURNING id`,
        [tenantB],
      )
    ).rows[0]!.id;
    await expectFailure(
      () =>
        database.query(
          `INSERT INTO source_systems (tenant_id, name, type, priority) VALUES ($1, 'bad', 'api', 1001)`,
          [tenantA],
        ),
      '23514',
      'source_systems_priority_range',
    );

    const provenance = (entityId: string, path: string): Promise<unknown> =>
      database.query(
        `INSERT INTO entity_field_provenance (tenant_id, entity_id, field_path, canonical_value, raw_value, source_record_id, source_system_id, source_external_id, source_priority, selection_rule, completeness_score, observed_at, normalization_version, canonicalization_version)
       VALUES ($1, $2, $3, '"v"'::jsonb, '"v"'::jsonb, $4, $5, 'external', 100, 'ONLY_CANDIDATE', 1, CURRENT_TIMESTAMP, 'normalization-v1', 'canonicalization-v1')`,
        [tenantA, entityId, path, recordA, sourceA],
      );
    await provenance(entityA, 'name');
    await expectFailure(
      () => provenance(entityA, 'name'),
      '23505',
      'entity_field_provenance_tenant_entity_field_key',
    );
    await expectFailure(
      () => provenance(entityB, 'cross'),
      '23503',
      'entity_field_provenance_tenant_entity_fkey',
    );

    const version = (entityId: string, recordId: string, number: number): Promise<unknown> =>
      database.query(
        `INSERT INTO entity_canonical_versions (tenant_id, entity_id, version, canonical_data, provenance, trigger_source_record_id, trigger_operation, canonicalization_version)
       VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, $4, 'ENTITY_CREATED', 'canonicalization-v1')`,
        [tenantA, entityId, number, recordId],
      );
    await version(entityA, recordA, 1);
    await expectFailure(
      () => version(entityA, recordA, 1),
      '23505',
      'entity_canonical_versions_tenant_entity_version_key',
    );
    await expectFailure(
      () => version(entityB, recordB, 2),
      '23503',
      'entity_canonical_versions_tenant_entity_fkey',
    );
  });
});
