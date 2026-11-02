import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

describe('Week 2 Day 6 additive migration', () => {
  const schema = `resolve_day6_upgrade_${process.pid}_${Date.now()}`;
  const url = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  url.searchParams.delete('schema');
  const db = new Client({ connectionString: url.toString() });
  beforeAll(async () => {
    await db.connect();
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
  });
  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  });
  it('preserves preexisting cases, records, links, and evidence without inventing historical versions', async () => {
    const root = resolve('packages/database/prisma/migrations');
    const day6 = '20261102_week2_day6_reviews';
    for (const directory of (await readdir(root))
      .filter((name) => /^\d/.test(name) && name < day6)
      .sort())
      await db.query(await readFile(resolve(root, directory, 'migration.sql'), 'utf8'));
    async function id(sql: string, args: unknown[] = []): Promise<string> {
      return (await db.query<{ id: string }>(sql, args)).rows[0]!.id;
    }
    const tenant = await id(`INSERT INTO tenants(name) VALUES ('Legacy') RETURNING id`);
    const source = await id(
      `INSERT INTO source_systems(tenant_id,name,type) VALUES ($1,'legacy','csv') RETURNING id`,
      [tenant],
    );
    const entity = await id(
      `INSERT INTO entities(tenant_id,entity_type) VALUES ($1,'PERSON') RETURNING id`,
      [tenant],
    );
    const candidate = await id(
      `INSERT INTO source_records(tenant_id,source_system_id,external_id,entity_type,raw_payload) VALUES ($1,$2,'a','PERSON','{"name":"Legacy"}') RETURNING id`,
      [tenant, source],
    );
    const incoming = await id(
      `INSERT INTO source_records(tenant_id,source_system_id,external_id,entity_type,raw_payload) VALUES ($1,$2,'b','PERSON','{"name":"Legacy B"}') RETURNING id`,
      [tenant, source],
    );
    await db.query(
      `INSERT INTO entity_record_links(tenant_id,entity_id,source_record_id,score,decision,algorithm_version) VALUES ($1,$2,$3,0,'NO_MATCH','rules-0.1.0')`,
      [tenant, entity, candidate],
    );
    const feature = await id(
      `INSERT INTO match_features(tenant_id,source_record_id,candidate_source_record_id,candidate_entity_id,feature_version,algorithm_version,score_inputs,explanation,score,decision)
      VALUES($1,$2,$3,$4,'features-v1','rules-0.1.0','{}','{}',0.8,'REVIEW') RETURNING id`,
      [tenant, incoming, candidate, entity],
    );
    const review = await id(
      `INSERT INTO review_cases(tenant_id,source_record_id,candidate_source_record_id,candidate_entity_id,match_feature_id,score,explanation,algorithm_version)
      VALUES($1,$2,$3,$4,$5,0.8,'{}','rules-0.1.0') RETURNING id`,
      [tenant, incoming, candidate, entity, feature],
    );
    const snapshot = async (): Promise<unknown> =>
      (
        await db.query<{ value: unknown }>(`SELECT jsonb_build_object(
      'records',(SELECT jsonb_agg(r ORDER BY id) FROM source_records r),
      'features',(SELECT jsonb_agg(f ORDER BY id) FROM match_features f)) AS value`)
      ).rows[0]!.value;
    const before = await snapshot();
    const oldCase = (
      await db.query<Record<string, unknown>>('SELECT * FROM review_cases WHERE id=$1', [review])
    ).rows[0]!;
    await db.query(await readFile(resolve(root, day6, 'migration.sql'), 'utf8'));
    expect(await snapshot()).toEqual(before);
    expect(
      (await db.query<Record<string, unknown>>('SELECT * FROM review_cases WHERE id=$1', [review]))
        .rows[0],
    ).toEqual({ ...oldCase, source_record_version: null, candidate_record_version: null });
    expect(
      (
        await db.query<{ review_decision_id: string | null }>(
          'SELECT review_decision_id FROM entity_record_links',
        )
      ).rows,
    ).toEqual([{ review_decision_id: null }]);
    expect(
      (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM review_decisions'))
        .rows[0]!.count,
    ).toBe(0);
  });
});
