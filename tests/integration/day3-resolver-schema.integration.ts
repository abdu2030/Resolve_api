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

describe('Day 3 resolver decision schema', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = `resolve_day3_schema_${process.pid}_${Date.now()}`;
  const schemaIdentifier = quoteIdentifier(schemaName);
  const adminUrl = databaseUrlForSchema(baseDatabaseUrl);
  const migrationUrl = databaseUrlForSchema(baseDatabaseUrl, schemaName);

  let admin: Client | undefined;
  let database: Client | undefined;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await execFileAsync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--config', prismaConfig],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DATABASE_URL: migrationUrl },
        maxBuffer: 1024 * 1024,
      },
    );
    database = new Client({ connectionString: adminUrl });
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

  it('creates required review-case and link-explanation columns', async () => {
    const columns = await database!.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1
          AND (
            table_name = 'review_cases'
            OR (table_name = 'entity_record_links' AND column_name = 'explanation')
          )
        ORDER BY table_name, column_name`,
      [schemaName],
    );

    expect(columns.rows).toEqual(
      expect.arrayContaining([
        { column_name: 'algorithm_version', is_nullable: 'NO' },
        { column_name: 'candidate_entity_id', is_nullable: 'NO' },
        { column_name: 'candidate_source_record_id', is_nullable: 'NO' },
        { column_name: 'explanation', is_nullable: 'NO' },
        { column_name: 'match_feature_id', is_nullable: 'NO' },
        { column_name: 'score', is_nullable: 'NO' },
        { column_name: 'source_record_id', is_nullable: 'NO' },
        { column_name: 'status', is_nullable: 'NO' },
        { column_name: 'tenant_id', is_nullable: 'NO' },
      ]),
    );
    expect(columns.rows.filter(({ column_name }) => column_name === 'explanation')).toHaveLength(2);
  });

  it('ties a review case to tenant-consistent selected evidence', async () => {
    const tenantA = await insertTenant(database!, 'Review Tenant A');
    const tenantB = await insertTenant(database!, 'Review Tenant B');
    const sourceA = await insertSource(database!, tenantA);
    const sourceB = await insertSource(database!, tenantB);
    const incomingA = await insertRecord(database!, tenantA, sourceA, 'incoming-a');
    const candidateA = await insertRecord(database!, tenantA, sourceA, 'candidate-a');
    const candidateB = await insertRecord(database!, tenantB, sourceB, 'candidate-b');
    const entityA = await insertEntity(database!, tenantA);
    const entityB = await insertEntity(database!, tenantB);
    const evidenceA = await insertEvidence(database!, {
      tenantId: tenantA,
      recordId: incomingA,
      candidateRecordId: candidateA,
      entityId: entityA,
    });

    await expectDatabaseFailure(
      () =>
        insertReview(database!, {
          tenantId: tenantA,
          recordId: incomingA,
          candidateRecordId: candidateB,
          entityId: entityA,
          evidenceId: evidenceA,
        }),
      { code: '23503', constraint: 'review_cases_tenant_candidate_record_fkey' },
    );

    await expectDatabaseFailure(
      () =>
        insertReview(database!, {
          tenantId: tenantA,
          recordId: incomingA,
          candidateRecordId: candidateA,
          entityId: entityB,
          evidenceId: evidenceA,
        }),
      { code: '23503', constraint: 'review_cases_tenant_candidate_entity_fkey' },
    );

    await insertReview(database!, {
      tenantId: tenantA,
      recordId: incomingA,
      candidateRecordId: candidateA,
      entityId: entityA,
      evidenceId: evidenceA,
    });

    await expectDatabaseFailure(
      () =>
        insertReview(database!, {
          tenantId: tenantA,
          recordId: incomingA,
          candidateRecordId: candidateA,
          entityId: entityA,
          evidenceId: evidenceA,
        }),
      { code: '23505', constraint: 'review_cases_tenant_source_record_key' },
    );
  });

  it('rejects a selected evidence row for a different source-candidate pair', async () => {
    const tenantId = await insertTenant(database!, 'Evidence Pair Tenant');
    const sourceId = await insertSource(database!, tenantId);
    const incomingA = await insertRecord(database!, tenantId, sourceId, 'incoming-pair-a');
    const incomingB = await insertRecord(database!, tenantId, sourceId, 'incoming-pair-b');
    const candidate = await insertRecord(database!, tenantId, sourceId, 'candidate-pair');
    const entityId = await insertEntity(database!, tenantId);
    const evidenceA = await insertEvidence(database!, {
      tenantId,
      recordId: incomingA,
      candidateRecordId: candidate,
      entityId,
    });

    await expectDatabaseFailure(
      () =>
        insertReview(database!, {
          tenantId,
          recordId: incomingB,
          candidateRecordId: candidate,
          entityId,
          evidenceId: evidenceA,
        }),
      { code: '23503', constraint: 'review_cases_selected_match_feature_fkey' },
    );
  });

  it('defaults link explanations and bounds review scores', async () => {
    const tenantId = await insertTenant(database!, 'Link Explanation Tenant');
    const sourceId = await insertSource(database!, tenantId);
    const incoming = await insertRecord(database!, tenantId, sourceId, 'link-record');
    const candidate = await insertRecord(database!, tenantId, sourceId, 'review-candidate');
    const entityId = await insertEntity(database!, tenantId);
    const evidenceId = await insertEvidence(database!, {
      tenantId,
      recordId: incoming,
      candidateRecordId: candidate,
      entityId,
    });

    const link = await database!.query<{ explanation: Record<string, unknown> }>(
      `INSERT INTO entity_record_links
         (tenant_id, entity_id, source_record_id, score, decision, algorithm_version)
       VALUES ($1, $2, $3, 0.0000, 'NO_MATCH', 'rules-0.1.0')
       RETURNING explanation`,
      [tenantId, entityId, incoming],
    );
    expect(link.rows[0]!.explanation).toEqual({
      candidate_count: 0,
      features: {},
      contradictions: [],
    });

    await expectDatabaseFailure(
      () =>
        insertReview(database!, {
          tenantId,
          recordId: incoming,
          candidateRecordId: candidate,
          entityId,
          evidenceId,
          score: '1.0001',
        }),
      { code: '23514', constraint: 'review_cases_score_range' },
    );
  });
});

function databaseUrlForSchema(databaseUrl: string, schema?: string): string {
  const url = new URL(databaseUrl);
  if (schema) url.searchParams.set('schema', schema);
  else url.searchParams.delete('schema');
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return '"' + identifier.replaceAll('"', '""') + '"';
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

async function insertTenant(database: Client, name: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [name],
  );
  return result.rows[0]!.id;
}

async function insertSource(database: Client, tenantId: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO source_systems (tenant_id, name, type)
     VALUES ($1, $2, 'test') RETURNING id`,
    [tenantId, `source-${crypto.randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function insertRecord(
  database: Client,
  tenantId: string,
  sourceId: string,
  externalId: string,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO source_records
       (tenant_id, source_system_id, external_id, entity_type, raw_payload)
     VALUES ($1, $2, $3, 'PERSON', '{"name":"Test"}'::jsonb)
     RETURNING id`,
    [tenantId, sourceId, externalId],
  );
  return result.rows[0]!.id;
}

async function insertEntity(database: Client, tenantId: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO entities (tenant_id, entity_type)
     VALUES ($1, 'PERSON') RETURNING id`,
    [tenantId],
  );
  return result.rows[0]!.id;
}

async function insertEvidence(
  database: Client,
  input: {
    tenantId: string;
    recordId: string;
    candidateRecordId: string;
    entityId: string;
  },
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO match_features
       (tenant_id, source_record_id, candidate_source_record_id,
        candidate_entity_id, feature_version, algorithm_version,
        score_inputs, explanation, score, decision)
     VALUES ($1, $2, $3, $4, 'features-v1', 'rules-0.1.0',
             '{}'::jsonb, '{}'::jsonb, 0.8000, 'REVIEW')
     RETURNING id`,
    [input.tenantId, input.recordId, input.candidateRecordId, input.entityId],
  );
  return result.rows[0]!.id;
}

async function insertReview(
  database: Client,
  input: {
    tenantId: string;
    recordId: string;
    candidateRecordId: string;
    entityId: string;
    evidenceId: string;
    score?: string;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO review_cases
       (tenant_id, source_record_id, candidate_source_record_id,
        candidate_entity_id, match_feature_id, score, explanation, algorithm_version)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'rules-0.1.0')`,
    [
      input.tenantId,
      input.recordId,
      input.candidateRecordId,
      input.entityId,
      input.evidenceId,
      input.score ?? '0.8000',
    ],
  );
}
