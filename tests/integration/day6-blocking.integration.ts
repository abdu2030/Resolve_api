import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { DatabaseEntityType, Prisma, type ResolvePrismaClient } from '@resolve/database';
import { Client } from 'pg';

import type { ResolveApplication } from '../../apps/api/src/application.js';
import { CandidateGenerationService } from '../../apps/api/src/blocking/candidate-generation.service.js';
import { CandidateSourceRecordNotFoundError } from '../../apps/api/src/blocking/candidate-source-record-not-found.error.js';
import {
  BLOCKING_QUERY_INDEXES,
  companyDomainQuery,
  exactEmailQuery,
  exactPhoneQuery,
  nameLocationQuery,
} from '../../apps/api/src/blocking/blocking.queries.js';
import type { BlockingSignal } from '../../apps/api/src/blocking/blocking.types.js';
import { PRISMA_CLIENT } from '../../apps/api/src/infrastructure/infrastructure.tokens.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const prismaCli = resolve(repositoryRoot, 'node_modules/prisma/build/index.js');
const prismaConfig = resolve(repositoryRoot, 'prisma.config.ts');
const originalEnvironment = {
  BLOCKING_MAX_CANDIDATES: process.env.BLOCKING_MAX_CANDIDATES,
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  API_PORT: process.env.API_PORT,
  REDIS_HOST: process.env.REDIS_HOST,
  REDIS_PORT: process.env.REDIS_PORT,
  REQUEST_BODY_LIMIT: process.env.REQUEST_BODY_LIMIT,
};

interface RecordSeed {
  id: string;
  tenantId: string;
  sourceSystemId: string;
  externalId: string;
  entityType?: DatabaseEntityType;
  email?: string;
  phone?: string;
  domain?: string;
  namePrefix?: string;
  city?: string;
  country?: string;
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

describe('Day 6 blocking v1', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = 'resolve_day6_blocking_' + process.pid + '_' + Date.now();
  const adminUrl = databaseUrlForSchema(baseDatabaseUrl);
  const isolatedUrl = databaseUrlForSchema(baseDatabaseUrl, schemaName);

  let admin: Client;
  let database: Client;
  let app: ResolveApplication;
  let service: CandidateGenerationService;
  let prisma: ResolvePrismaClient;
  let tenantA: string;
  let tenantB: string;
  let sourceA: string;
  let sourceB: string;

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

    process.env.BLOCKING_MAX_CANDIDATES = '2';
    process.env.DATABASE_URL = isolatedUrl;
    process.env.NODE_ENV = 'test';
    process.env.API_PORT = '3000';
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.REQUEST_BODY_LIMIT = '1mb';

    database = new Client({ connectionString: adminUrl });
    await database.connect();
    await database.query('SET search_path TO ' + quoteIdentifier(schemaName));
    tenantA = await insertTenant(database, 'Day 6 Tenant A');
    tenantB = await insertTenant(database, 'Day 6 Tenant B');
    sourceA = await insertSource(database, tenantA, 'blocking-a');
    sourceB = await insertSource(database, tenantB, 'blocking-b');

    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    service = app.get(CandidateGenerationService);
    prisma = app.get(PRISMA_CLIENT);
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

  it('unions all signals and deduplicates records belonging to one entity', async () => {
    const incomingId = '00000000-0000-0000-0000-000000000001';
    const entityId = '10000000-0000-0000-0000-000000000001';
    const supportingId = '20000000-0000-0000-0000-000000000001';
    const duplicateId = '20000000-0000-0000-0000-000000000002';
    await insertRecord(database, {
      id: incomingId,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'union-incoming',
      email: 'Union@example.com',
      phone: '+251911000001',
      domain: 'union.example',
      namePrefix: 'union person',
      city: 'addis ababa',
      country: 'ET',
    });
    await insertEntity(database, entityId, tenantA, DatabaseEntityType.PERSON);
    await insertRecord(database, {
      id: supportingId,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'union-support',
      email: 'Union@example.com',
      phone: '+251911000001',
      domain: 'union.example',
      namePrefix: 'union person',
      city: 'addis ababa',
      country: 'ET',
    });
    await insertRecord(database, {
      id: duplicateId,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'union-duplicate',
      email: 'Union@example.com',
    });
    await insertLink(database, tenantA, entityId, supportingId);
    await insertLink(database, tenantA, entityId, duplicateId);

    await expect(service.findCandidates(tenantA, incomingId)).resolves.toEqual({
      blockingVersion: 'blocking-v1',
      candidates: [
        {
          entityId,
          entityType: 'PERSON',
          matchedOn: ['EXACT_EMAIL', 'EXACT_PHONE', 'COMPANY_DOMAIN', 'NAME_LOCATION'],
          supportingRecordIds: [supportingId],
        },
      ],
      truncated: false,
    });
  });

  it('excludes self, unlinked, cross-tenant, and different-type records', async () => {
    const incomingId = '00000000-0000-0000-0000-000000000010';
    const expectedEntity = '10000000-0000-0000-0000-000000000010';
    const expectedRecord = '20000000-0000-0000-0000-000000000010';
    await insertRecord(database, {
      id: incomingId,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'isolation-incoming',
      email: 'Isolation@example.com',
    });
    await insertEntity(database, expectedEntity, tenantA, DatabaseEntityType.PERSON);
    await insertRecord(database, {
      id: expectedRecord,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'isolation-expected',
      email: 'Isolation@example.com',
    });
    await insertLink(database, tenantA, expectedEntity, expectedRecord);

    const selfEntity = '10000000-0000-0000-0000-000000000011';
    await insertEntity(database, selfEntity, tenantA, DatabaseEntityType.PERSON);
    await insertLink(database, tenantA, selfEntity, incomingId);
    await insertRecord(database, {
      id: '20000000-0000-0000-0000-000000000012',
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'isolation-unlinked',
      email: 'Isolation@example.com',
    });

    const otherTenantEntity = '10000000-0000-0000-0000-000000000013';
    const otherTenantRecord = '20000000-0000-0000-0000-000000000013';
    await insertEntity(database, otherTenantEntity, tenantB, DatabaseEntityType.PERSON);
    await insertRecord(database, {
      id: otherTenantRecord,
      tenantId: tenantB,
      sourceSystemId: sourceB,
      externalId: 'isolation-other-tenant',
      email: 'Isolation@example.com',
    });
    await insertLink(database, tenantB, otherTenantEntity, otherTenantRecord);

    const companyEntity = '10000000-0000-0000-0000-000000000014';
    const companyRecord = '20000000-0000-0000-0000-000000000014';
    await insertEntity(database, companyEntity, tenantA, DatabaseEntityType.COMPANY);
    await insertRecord(database, {
      id: companyRecord,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'isolation-company',
      entityType: DatabaseEntityType.COMPANY,
      email: 'Isolation@example.com',
    });
    await insertLink(database, tenantA, companyEntity, companyRecord);

    const result = await service.findCandidates(tenantA, incomingId);
    expect(result.candidates).toEqual([
      {
        entityId: expectedEntity,
        entityType: 'PERSON',
        matchedOn: ['EXACT_EMAIL'],
        supportingRecordIds: [expectedRecord],
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('skips name/location fallback unless both city and country exist', async () => {
    const incomingId = '00000000-0000-0000-0000-000000000020';
    const entityId = '10000000-0000-0000-0000-000000000020';
    const supportingId = '20000000-0000-0000-0000-000000000020';
    await insertRecord(database, {
      id: incomingId,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'location-incoming',
      namePrefix: 'location person',
      city: 'addis ababa',
    });
    await insertEntity(database, entityId, tenantA, DatabaseEntityType.PERSON);
    await insertRecord(database, {
      id: supportingId,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'location-support',
      namePrefix: 'location person',
      city: 'addis ababa',
      country: 'ET',
    });
    await insertLink(database, tenantA, entityId, supportingId);

    await expect(service.findCandidates(tenantA, incomingId)).resolves.toEqual({
      blockingVersion: 'blocking-v1',
      candidates: [],
      truncated: false,
    });
  });

  it('applies a deterministic final cap and reports truncation', async () => {
    const incomingId = '00000000-0000-0000-0000-000000000030';
    await insertRecord(database, {
      id: incomingId,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'cap-incoming',
      email: 'Cap@example.com',
    });

    for (const suffix of ['031', '032', '033']) {
      const entityId = '10000000-0000-0000-0000-000000000' + suffix;
      const recordId = '20000000-0000-0000-0000-000000000' + suffix;
      await insertEntity(database, entityId, tenantA, DatabaseEntityType.PERSON);
      await insertRecord(database, {
        id: recordId,
        tenantId: tenantA,
        sourceSystemId: sourceA,
        externalId: 'cap-support-' + suffix,
        email: 'Cap@example.com',
      });
      await insertLink(database, tenantA, entityId, recordId);
    }

    const result = await service.findCandidates(tenantA, incomingId);
    expect(result.candidates.map(({ entityId }) => entityId)).toEqual([
      '10000000-0000-0000-0000-000000000031',
      '10000000-0000-0000-0000-000000000032',
    ]);
    expect(result.truncated).toBe(true);
  });

  it('uses one not-found error for unknown and cross-tenant record IDs', async () => {
    const tenantBRecord = '20000000-0000-0000-0000-000000000040';
    await insertRecord(database, {
      id: tenantBRecord,
      tenantId: tenantB,
      sourceSystemId: sourceB,
      externalId: 'not-found-other-tenant',
      email: 'Hidden@example.com',
    });

    await expect(
      service.findCandidates(tenantA, '00000000-0000-0000-0000-000000000099'),
    ).rejects.toBeInstanceOf(CandidateSourceRecordNotFoundError);
    await expect(service.findCandidates(tenantA, tenantBRecord)).rejects.toBeInstanceOf(
      CandidateSourceRecordNotFoundError,
    );
  });

  it('uses every blocking index without scanning source_records', async () => {
    const incomingId = '00000000-0000-0000-0000-000000000050';
    const entityId = '10000000-0000-0000-0000-000000000050';
    const supportingId = '20000000-0000-0000-0000-000000000050';
    await insertRecord(database, {
      id: incomingId,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'plan-incoming',
      email: 'PlanTarget@example.com',
      phone: '+251911000050',
      domain: 'plan-target.example',
      namePrefix: 'plan target',
      city: 'addis ababa',
      country: 'ET',
    });
    await insertEntity(database, entityId, tenantA, DatabaseEntityType.PERSON);
    await insertRecord(database, {
      id: supportingId,
      tenantId: tenantA,
      sourceSystemId: sourceA,
      externalId: 'plan-support',
      email: 'PlanTarget@example.com',
      phone: '+251911000050',
      domain: 'plan-target.example',
      namePrefix: 'plan target',
      city: 'addis ababa',
      country: 'ET',
    });
    await insertLink(database, tenantA, entityId, supportingId);
    await seedPlanDistractors(database, tenantA, sourceA, 2000);
    await database.query('ANALYZE source_records');
    await database.query('ANALYZE entity_record_links');
    await database.query('ANALYZE entities');

    await expect(service.findCandidates(tenantA, incomingId)).resolves.toMatchObject({
      candidates: [{ entityId }],
    });

    const common = {
      schema: schemaName,
      tenantId: tenantA,
      sourceRecordId: incomingId,
      entityType: DatabaseEntityType.PERSON,
      limit: 3,
    };
    const queries: Array<{ signal: BlockingSignal; query: Prisma.Sql }> = [
      {
        signal: 'EXACT_EMAIL',
        query: exactEmailQuery({ ...common, value: 'PlanTarget@example.com' }),
      },
      {
        signal: 'EXACT_PHONE',
        query: exactPhoneQuery({ ...common, value: '+251911000050' }),
      },
      {
        signal: 'COMPANY_DOMAIN',
        query: companyDomainQuery({ ...common, value: 'plan-target.example' }),
      },
      {
        signal: 'NAME_LOCATION',
        query: nameLocationQuery({
          ...common,
          namePrefix: 'plan target',
          city: 'addis ababa',
          country: 'ET',
        }),
      },
    ];

    for (const { signal, query } of queries) {
      const nodes = await explainNodes(prisma, query);
      const indexNames = nodes
        .map((node) => node['Index Name'])
        .filter((name): name is string => typeof name === 'string');
      expect(indexNames).toContain(BLOCKING_QUERY_INDEXES[signal]);
      expect(
        nodes.some(
          (node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'source_records',
        ),
      ).toBe(false);
    }
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
    "INSERT INTO source_systems (tenant_id, name, type) VALUES ($1, $2, 'api') RETURNING id",
    [tenantId, name],
  );
  return result.rows[0]!.id;
}

async function insertRecord(database: Client, seed: RecordSeed): Promise<void> {
  const normalizedPayload = {
    address:
      seed.city || seed.country ? { city: seed.city ?? null, country: seed.country ?? null } : null,
  };
  await database.query(
    `INSERT INTO source_records
       (id, tenant_id, source_system_id, external_id, entity_type, raw_payload,
        normalized_payload, normalization_version, normalized_email,
        normalized_phone, company_domain, normalized_name_prefix)
     VALUES
       ($1, $2, $3, $4, $5::entity_type, '{}'::jsonb, $6::jsonb,
        'normalization-v1', $7, $8, $9, $10)`,
    [
      seed.id,
      seed.tenantId,
      seed.sourceSystemId,
      seed.externalId,
      seed.entityType ?? DatabaseEntityType.PERSON,
      JSON.stringify(normalizedPayload),
      seed.email ?? null,
      seed.phone ?? null,
      seed.domain ?? null,
      seed.namePrefix ?? null,
    ],
  );
}

async function insertEntity(
  database: Client,
  id: string,
  tenantId: string,
  entityType: DatabaseEntityType,
): Promise<void> {
  await database.query(
    `INSERT INTO entities (id, tenant_id, entity_type)
     VALUES ($1, $2, $3::entity_type)`,
    [id, tenantId, entityType],
  );
}

async function insertLink(
  database: Client,
  tenantId: string,
  entityId: string,
  sourceRecordId: string,
): Promise<void> {
  await database.query(
    `INSERT INTO entity_record_links
       (tenant_id, entity_id, source_record_id, score, decision, algorithm_version)
     VALUES ($1, $2, $3, 1, 'AUTO_MATCH', 'test-seed-v1')`,
    [tenantId, entityId, sourceRecordId],
  );
}

async function seedPlanDistractors(
  database: Client,
  tenantId: string,
  sourceSystemId: string,
  count: number,
): Promise<void> {
  await database.query(
    `CREATE TEMP TABLE blocking_plan_seed (
       entity_id UUID NOT NULL,
       record_id UUID NOT NULL,
       ordinal INTEGER NOT NULL
     )`,
  );
  await database.query(
    `INSERT INTO blocking_plan_seed (entity_id, record_id, ordinal)
     SELECT gen_random_uuid(), gen_random_uuid(), value
     FROM generate_series(1, $1) AS value`,
    [count],
  );
  await database.query(
    `INSERT INTO entities (id, tenant_id, entity_type)
     SELECT entity_id, $1, 'PERSON' FROM blocking_plan_seed`,
    [tenantId],
  );
  await database.query(
    `INSERT INTO source_records
       (id, tenant_id, source_system_id, external_id, entity_type, raw_payload,
        normalized_payload, normalization_version, normalized_email,
        normalized_phone, company_domain, normalized_name_prefix)
     SELECT record_id, $1, $2, 'plan-distractor-' || ordinal, 'PERSON',
       '{}'::jsonb,
       jsonb_build_object(
         'address',
         jsonb_build_object('city', 'city-' || ordinal, 'country', 'ET')
       ),
       'normalization-v1',
       'Plan-' || ordinal || '@example.test',
       '+1999' || lpad(ordinal::text, 8, '0'),
       'plan-' || ordinal || '.example.test',
       'plan person ' || ordinal
     FROM blocking_plan_seed`,
    [tenantId, sourceSystemId],
  );
  await database.query(
    `INSERT INTO entity_record_links
       (tenant_id, entity_id, source_record_id, score, decision, algorithm_version)
     SELECT $1, entity_id, record_id, 1, 'AUTO_MATCH', 'test-plan-v1'
     FROM blocking_plan_seed`,
    [tenantId],
  );
  await database.query('DROP TABLE blocking_plan_seed');
}

type ExplainNode = Record<string, unknown>;

async function explainNodes(
  prisma: ResolvePrismaClient,
  query: Prisma.Sql,
): Promise<ExplainNode[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(
    Prisma.sql`EXPLAIN (FORMAT JSON) ${query}`,
  );
  const document = rows[0]?.['QUERY PLAN'];
  if (!Array.isArray(document) || document.length === 0) {
    throw new Error('PostgreSQL returned an invalid JSON query plan');
  }
  const root = (document as unknown[])[0];
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('PostgreSQL query plan root is invalid');
  }
  return collectPlanNodes((root as ExplainNode).Plan);
}

function collectPlanNodes(value: unknown): ExplainNode[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  const node = value as ExplainNode;
  const plans: unknown[] = Array.isArray(node.Plans) ? node.Plans : [];
  const children = plans.flatMap((child) => collectPlanNodes(child));
  return [node, ...children];
}
