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

describe('Day 2 scoring evidence persistence', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = `resolve_scoring_${process.pid}_${Date.now()}`;
  const schemaIdentifier = `"${schemaName.replaceAll('"', '""')}"`;
  const adminUrl = withoutPrismaSchema(baseDatabaseUrl);
  const migrationUrl = withPrismaSchema(baseDatabaseUrl, schemaName);

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

  it('stores versioned score inputs and explanations', async () => {
    const tenantId = await insertTenant(database!, 'Scoring Tenant');
    const sourceId = await insertSource(database!, tenantId);
    const recordId = await insertRecord(database!, tenantId, sourceId);
    const candidateRecordId = await insertRecord(database!, tenantId, sourceId);
    const entityId = await insertEntity(database!, tenantId);
    const inputs = {
      featureVersion: 'features-v1',
      entityType: 'person',
      features: { email_exact: true },
      contradictions: [],
    };
    const explanation = {
      signals: { email: 1 },
      weights: { email: 0.4 },
      thresholds: { autoMatch: 0.92, review: 0.72 },
    };

    const stored = await database!.query<{
      algorithm_version: string;
      decision: string;
      candidate_source_record_id: string;
      explanation: Record<string, unknown>;
      feature_version: string;
      score: string;
      score_inputs: Record<string, unknown>;
    }>(
      `INSERT INTO match_features
         (tenant_id, source_record_id, candidate_source_record_id,
          candidate_entity_id, feature_version,
          algorithm_version, score_inputs, explanation, score, decision)
       VALUES ($1, $2, $3, $4, 'features-v1', 'rules-0.1.0', $5::jsonb, $6::jsonb, 0.9500, 'AUTO_MATCH')
       RETURNING candidate_source_record_id, feature_version, algorithm_version,
                 score_inputs, explanation, score, decision`,
      [
        tenantId,
        recordId,
        candidateRecordId,
        entityId,
        JSON.stringify(inputs),
        JSON.stringify(explanation),
      ],
    );

    expect(stored.rows[0]).toEqual({
      feature_version: 'features-v1',
      algorithm_version: 'rules-0.1.0',
      candidate_source_record_id: candidateRecordId,
      score_inputs: inputs,
      explanation,
      score: '0.9500',
      decision: 'AUTO_MATCH',
    });
  });

  it('enforces tenant-safe record-pair and candidate-entity references', async () => {
    const tenantA = await insertTenant(database!, 'Evidence Tenant A');
    const tenantB = await insertTenant(database!, 'Evidence Tenant B');
    const sourceA = await insertSource(database!, tenantA);
    const sourceB = await insertSource(database!, tenantB);
    const recordA = await insertRecord(database!, tenantA, sourceA);
    const recordB = await insertRecord(database!, tenantB, sourceB);
    const entityA = await insertEntity(database!, tenantA);
    const entityB = await insertEntity(database!, tenantB);

    await expectDatabaseFailure(
      () =>
        insertEvidence(database!, {
          tenantId: tenantA,
          recordId: recordA,
          candidateRecordId: recordA,
          entityId: entityB,
          score: '0.8000',
        }),
      {
        code: '23503',
        constraint: 'match_features_tenant_candidate_entity_fkey',
      },
    );
    await expectDatabaseFailure(
      () =>
        insertEvidence(database!, {
          tenantId: tenantA,
          recordId: recordA,
          candidateRecordId: recordB,
          entityId: entityA,
          score: '0.8000',
        }),
      {
        code: '23503',
        constraint: 'match_features_tenant_candidate_record_fkey',
      },
    );
    await expectDatabaseFailure(
      () =>
        insertEvidence(database!, {
          tenantId: tenantA,
          recordId: recordB,
          candidateRecordId: recordA,
          entityId: entityA,
          score: '0.8000',
        }),
      {
        code: '23503',
        constraint: 'match_features_tenant_source_record_fkey',
      },
    );
  });

  it('enforces the inclusive score range', async () => {
    const tenantId = await insertTenant(database!, 'Score Range Tenant');
    const sourceId = await insertSource(database!, tenantId);
    const recordId = await insertRecord(database!, tenantId, sourceId);
    const entityId = await insertEntity(database!, tenantId);

    await insertEvidence(database!, {
      tenantId,
      recordId,
      candidateRecordId: recordId,
      entityId,
      score: '0.0000',
    });
    await insertEvidence(database!, {
      tenantId,
      recordId,
      candidateRecordId: recordId,
      entityId,
      score: '1.0000',
    });
    await expectDatabaseFailure(
      () =>
        insertEvidence(database!, {
          tenantId,
          recordId,
          candidateRecordId: recordId,
          entityId,
          score: '1.0001',
        }),
      { code: '23514', constraint: 'match_features_score_range' },
    );
  });
});

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

async function insertRecord(database: Client, tenantId: string, sourceId: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO source_records
       (tenant_id, source_system_id, external_id, entity_type, raw_payload)
     VALUES ($1, $2, $3, 'PERSON', '{"name":"Test"}'::jsonb)
     RETURNING id`,
    [tenantId, sourceId, crypto.randomUUID()],
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
    candidateRecordId: string;
    entityId: string;
    recordId: string;
    score: string;
    tenantId: string;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO match_features
       (tenant_id, source_record_id, candidate_source_record_id,
        candidate_entity_id, feature_version,
        algorithm_version, score_inputs, explanation, score, decision)
     VALUES ($1, $2, $3, $4, 'features-v1', 'rules-0.1.0', '{}'::jsonb, '{}'::jsonb, $5, 'REVIEW')`,
    [input.tenantId, input.recordId, input.candidateRecordId, input.entityId, input.score],
  );
}
