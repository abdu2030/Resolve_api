import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

const migrations = resolve('packages/database/prisma/migrations');
const day5 = '20261026_week2_day5_entity_operations';

async function denied(
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

describe('Week 2 Day 5 operation schema upgrade', () => {
  const schema = `resolve_day5_schema_${process.pid}_${Date.now()}`;
  const baseUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  baseUrl.searchParams.delete('schema');
  const database = new Client({ connectionString: baseUrl.toString() });
  let tenant: string;
  let foreignTenant: string;
  let actor: string;
  let foreignActor: string;
  let source: string;
  let target: string;
  let foreignEntity: string;
  let record: string;
  let link: string;
  let history: string;
  let oldEntity: Record<string, unknown>;
  let oldLink: Record<string, unknown>;
  let oldHistory: Record<string, unknown>;

  async function scalar(sql: string, args: unknown[] = []): Promise<string> {
    return (await database.query<{ id: string }>(sql, args)).rows[0]!.id;
  }

  beforeAll(async () => {
    await database.connect();
    await database.query(`CREATE SCHEMA "${schema}"`);
    await database.query(`SET search_path TO "${schema}"`);
    for (const directory of (await readdir(migrations)).filter((name) => name < day5).sort()) {
      const sql = resolve(migrations, directory, 'migration.sql');
      if (existsSync(sql)) await database.query(await readFile(sql, 'utf8'));
    }
    tenant = await scalar(`INSERT INTO tenants (name) VALUES ('A') RETURNING id`);
    foreignTenant = await scalar(`INSERT INTO tenants (name) VALUES ('B') RETURNING id`);
    actor = await scalar(
      `INSERT INTO api_keys (tenant_id,name,prefix,key_hash) VALUES ($1,'A','a','hash-a') RETURNING id`,
      [tenant],
    );
    foreignActor = await scalar(
      `INSERT INTO api_keys (tenant_id,name,prefix,key_hash) VALUES ($1,'B','b','hash-b') RETURNING id`,
      [foreignTenant],
    );
    source = await scalar(
      `INSERT INTO entities (tenant_id,entity_type,canonical_data,canonical_version) VALUES ($1,'PERSON','{"name":"Original"}',1) RETURNING id`,
      [tenant],
    );
    target = await scalar(
      `INSERT INTO entities (tenant_id,entity_type) VALUES ($1,'PERSON') RETURNING id`,
      [tenant],
    );
    foreignEntity = await scalar(
      `INSERT INTO entities (tenant_id,entity_type) VALUES ($1,'PERSON') RETURNING id`,
      [foreignTenant],
    );
    const sourceSystem = await scalar(
      `INSERT INTO source_systems (tenant_id,name,type) VALUES ($1,'crm','api') RETURNING id`,
      [tenant],
    );
    record = await scalar(
      `INSERT INTO source_records (tenant_id,source_system_id,external_id,entity_type,raw_payload) VALUES ($1,$2,'original','PERSON','{"name":"Original"}') RETURNING id`,
      [tenant, sourceSystem],
    );
    link = await scalar(
      `INSERT INTO entity_record_links (tenant_id,entity_id,source_record_id,score,decision,algorithm_version) VALUES ($1,$2,$3,0.96,'AUTO_MATCH','rules-0.1.0') RETURNING id`,
      [tenant, source, record],
    );
    history = await scalar(
      `INSERT INTO entity_canonical_versions (tenant_id,entity_id,version,canonical_data,provenance,trigger_source_record_id,trigger_operation,canonicalization_version) VALUES ($1,$2,1,'{"name":"Original"}','{}',$3,'ENTITY_CREATED','canonicalization-v1') RETURNING id`,
      [tenant, source, record],
    );
    oldEntity = (
      await database.query<Record<string, unknown>>('SELECT * FROM entities WHERE id=$1', [source])
    ).rows[0]!;
    oldLink = (
      await database.query<Record<string, unknown>>(
        'SELECT * FROM entity_record_links WHERE id=$1',
        [link],
      )
    ).rows[0]!;
    oldHistory = (
      await database.query<Record<string, unknown>>(
        'SELECT * FROM entity_canonical_versions WHERE id=$1',
        [history],
      )
    ).rows[0]!;
    const upgrade = resolve(migrations, day5, 'migration.sql');
    if (existsSync(upgrade)) await database.query(await readFile(upgrade, 'utf8'));
  });

  afterAll(async () => {
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.end();
  });

  async function event(overrides: Record<string, unknown> = {}): Promise<string> {
    const values = {
      tenant_id: tenant,
      type: 'MERGE',
      source_entity_id: source,
      target_entity_id: target,
      record_ids: JSON.stringify([record]),
      reason: 'Confirmed duplicate',
      actor_api_key_id: actor,
      source_version_before: 1,
      source_version_after: 2,
      target_version_before: 0,
      target_version_after: 1,
      reversed_operation_id: null,
      ...overrides,
    };
    return scalar(
      `INSERT INTO entity_operations (${Object.keys(values)
        .map((key) => `"${key}"`)
        .join(',')}) VALUES (${Object.keys(values)
        .map((_, i) => `$${i + 1}`)
        .join(',')}) RETURNING id`,
      Object.values(values),
    );
  }

  it('preserves existing rows and defaults lifecycle and new references safely', async () => {
    expect((await database.query('SELECT * FROM entities WHERE id=$1', [source])).rows[0]).toEqual({
      ...oldEntity,
      status: 'ACTIVE',
      merged_into_entity_id: null,
    });
    expect(
      (await database.query('SELECT * FROM entity_record_links WHERE id=$1', [link])).rows[0],
    ).toEqual({ ...oldLink, last_entity_operation_id: null });
    expect(
      (await database.query('SELECT * FROM entity_canonical_versions WHERE id=$1', [history]))
        .rows[0],
    ).toEqual({ ...oldHistory, entity_operation_id: null });
    expect(
      (await database.query('SELECT raw_payload FROM source_records WHERE id=$1', [record]))
        .rows[0],
    ).toEqual({ raw_payload: { name: 'Original' } });
  });

  it('enforces lifecycle consistency and tenant-safe merged targets', async () => {
    await denied(
      () => database.query(`UPDATE entities SET status='MERGED' WHERE id=$1`, [source]),
      '23514',
      'entities_lifecycle_consistency',
    );
    await denied(
      () =>
        database.query(`UPDATE entities SET merged_into_entity_id=$1 WHERE id=$2`, [
          target,
          source,
        ]),
      '23514',
      'entities_lifecycle_consistency',
    );
    await denied(
      () =>
        database.query(
          `UPDATE entities SET status='MERGED', merged_into_entity_id=id WHERE id=$1`,
          [source],
        ),
      '23514',
      'entities_lifecycle_consistency',
    );
    await denied(
      () =>
        database.query(
          `UPDATE entities SET status='MERGED', merged_into_entity_id=$1 WHERE id=$2`,
          [foreignEntity, source],
        ),
      '23503',
      'entities_tenant_merged_into_fkey',
    );
    await database.query(
      `UPDATE entities SET status='MERGED',merged_into_entity_id=$1 WHERE id=$2`,
      [target, source],
    );
    await database.query(
      `UPDATE entities SET status='ACTIVE',merged_into_entity_id=NULL WHERE id=$1`,
      [source],
    );
  });

  it('rejects self operations, malformed arrays, invalid counters and reversal states', async () => {
    await denied(
      () => event({ target_entity_id: source }),
      '23514',
      'entity_operations_distinct_entities',
    );
    for (const ids of ['{}', '[]', JSON.stringify(Array(1001).fill(record))])
      await denied(() => event({ record_ids: ids }), '23514', 'entity_operations_record_ids_count');
    for (const field of [
      'source_version_before',
      'source_version_after',
      'target_version_before',
      'target_version_after',
    ])
      await denied(() => event({ [field]: -1 }), '23514', 'entity_operations_versions_nonnegative');
    await denied(
      () => event({ type: 'UNMERGE' }),
      '23514',
      'entity_operations_reversal_consistency',
    );
    await denied(
      () => event({ reversed_operation_id: randomUUID() }),
      '23514',
      'entity_operations_reversal_consistency',
    );
  });

  it('enforces tenant-safe event actors/entities/reversals and one reversal per event', async () => {
    await denied(
      () => event({ actor_api_key_id: foreignActor }),
      '23503',
      'entity_operations_tenant_actor_fkey',
    );
    await denied(
      () => event({ source_entity_id: foreignEntity }),
      '23503',
      'entity_operations_tenant_source_fkey',
    );
    await denied(
      () => event({ target_entity_id: foreignEntity }),
      '23503',
      'entity_operations_tenant_target_fkey',
    );
    const foreignTarget = await scalar(
      `INSERT INTO entities (tenant_id,entity_type) VALUES ($1,'PERSON') RETURNING id`,
      [foreignTenant],
    );
    const foreignEvent = await event({
      tenant_id: foreignTenant,
      actor_api_key_id: foreignActor,
      source_entity_id: foreignEntity,
      target_entity_id: foreignTarget,
    });
    await denied(
      () => event({ type: 'UNMERGE', reversed_operation_id: foreignEvent }),
      '23503',
      'entity_operations_tenant_reversed_operation_fkey',
    );
    const original = await event();
    await event({ type: 'UNMERGE', reversed_operation_id: original });
    await denied(
      () => event({ type: 'UNMERGE', reversed_operation_id: original }),
      '23505',
      'entity_operations_tenant_reversed_operation_key',
    );
    expect(
      (
        await database.query('SELECT operation_version FROM entity_operations WHERE id=$1', [
          original,
        ])
      ).rows[0],
    ).toEqual({ operation_version: 'entity-operations-v1' });
  });

  it('accepts valid references and MERGE/SPLIT triggers while denying foreign references', async () => {
    const operation = await event();
    const foreignTarget = await scalar(
      `INSERT INTO entities (tenant_id,entity_type) VALUES ($1,'PERSON') RETURNING id`,
      [foreignTenant],
    );
    const foreignEvent = await event({
      tenant_id: foreignTenant,
      actor_api_key_id: foreignActor,
      source_entity_id: foreignEntity,
      target_entity_id: foreignTarget,
    });
    await denied(
      () =>
        database.query('UPDATE entity_record_links SET last_entity_operation_id=$1 WHERE id=$2', [
          foreignEvent,
          link,
        ]),
      '23503',
      'entity_record_links_tenant_last_operation_fkey',
    );
    await denied(
      () =>
        database.query('UPDATE entity_canonical_versions SET entity_operation_id=$1 WHERE id=$2', [
          foreignEvent,
          history,
        ]),
      '23503',
      'entity_canonical_versions_tenant_operation_fkey',
    );
    await database.query('UPDATE entity_record_links SET last_entity_operation_id=$1 WHERE id=$2', [
      operation,
      link,
    ]);
    for (const [index, trigger] of ['MERGE', 'SPLIT'].entries()) {
      await database.query(
        `INSERT INTO entity_canonical_versions (tenant_id,entity_id,version,canonical_data,provenance,trigger_operation,canonicalization_version,entity_operation_id) VALUES ($1,$2,$3,'{}','{}',$4,'canonicalization-v1',$5)`,
        [tenant, source, index + 2, trigger, operation],
      );
    }
    expect(
      (
        await database.query(
          'SELECT last_entity_operation_id FROM entity_record_links WHERE id=$1',
          [link],
        )
      ).rows[0],
    ).toEqual({ last_entity_operation_id: operation });
    expect(
      (
        await database.query(
          'SELECT count(*)::int AS count FROM entity_canonical_versions WHERE entity_operation_id=$1',
          [operation],
        )
      ).rows[0],
    ).toEqual({ count: 2 });
  });

  it('preserves operation events as append-only audit evidence', async () => {
    const operation = await event();
    await denied(
      () =>
        database.query('UPDATE entity_operations SET reason=$1 WHERE id=$2', [
          'Changed',
          operation,
        ]),
      '23514',
      'entity_operations_append_only',
    );
    await denied(
      () => database.query('DELETE FROM entity_operations WHERE id=$1', [operation]),
      '23514',
      'entity_operations_append_only',
    );
    expect(
      (await database.query('SELECT reason FROM entity_operations WHERE id=$1', [operation]))
        .rows[0],
    ).toEqual({ reason: 'Confirmed duplicate' });
  });
});
