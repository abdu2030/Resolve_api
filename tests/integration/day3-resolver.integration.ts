import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { EntityType } from '@resolve/contracts';
import { type ResolvePrismaClient } from '@resolve/database';
import { normalizeRecord } from '@resolve/normalization';
import { Client } from 'pg';

import type { ResolveApplication } from '../../apps/api/src/application.js';
import { PRISMA_CLIENT } from '../../apps/api/src/infrastructure/infrastructure.tokens.js';
import { ResolutionService } from '../../apps/api/src/resolution/resolution.service.js';
import type { ResolutionExecution } from '../../apps/api/src/resolution/resolution.types.js';

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

describe('Day 3 resolution service', () => {
  const baseDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://resolve:resolve@localhost:5432/resolve';
  const schemaName = `resolve_day3_service_${process.pid}_${Date.now()}`;
  const adminUrl = databaseUrlForSchema(baseDatabaseUrl);
  const isolatedUrl = databaseUrlForSchema(baseDatabaseUrl, schemaName);

  let admin: Client;
  let database: Client;
  let app: ResolveApplication;
  let prisma: ResolvePrismaClient;
  let resolution: ResolutionService;

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

    process.env.BLOCKING_MAX_CANDIDATES = '100';
    process.env.DATABASE_URL = isolatedUrl;
    process.env.NODE_ENV = 'test';
    process.env.API_PORT = '3000';
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.REQUEST_BODY_LIMIT = '1mb';

    database = new Client({ connectionString: adminUrl });
    await database.connect();
    await database.query('SET search_path TO ' + quoteIdentifier(schemaName));

    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    prisma = app.get(PRISMA_CLIENT);
    resolution = app.get(ResolutionService);
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

  it('creates and links a new entity when blocking returns no candidates', async () => {
    const tenantId = await insertTenant(database, 'No Match Tenant');
    const sourceId = await insertSource(database, tenantId);
    const incomingId = await insertPerson(database, tenantId, sourceId, 'incoming-new', {
      name: 'Unique Person',
      email: 'unique@example.com',
    });

    const outcome = await resolveRecord(prisma, resolution, tenantId, incomingId);

    expect(typeof outcome.entity_id).toBe('string');
    expect(outcome).toEqual({
      entity_id: outcome.entity_id,
      decision: 'NO_MATCH',
      confidence: 0,
      explanation: {
        candidate_count: 0,
        features: {},
        contradictions: [],
      },
      algorithm_version: 'rules-0.1.0',
    });
    expect(await prisma.entity.count({ where: { tenantId } })).toBe(1);
    expect(await prisma.entityRecordLink.count({ where: { tenantId } })).toBe(1);
    expect(await prisma.matchFeature.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.reviewCase.count({ where: { tenantId } })).toBe(0);
  });

  it('links the incoming record to one automatic candidate and stores evidence', async () => {
    const tenantId = await insertTenant(database, 'Automatic Match Tenant');
    const sourceId = await insertSource(database, tenantId);
    const candidateRecordId = await insertPerson(
      database,
      tenantId,
      sourceId,
      'automatic-candidate',
      {
        name: 'Automatic Person',
        email: 'auto@example.com',
        phone: '+251911222333',
      },
    );
    const entityId = await insertLinkedEntity(database, tenantId, candidateRecordId);
    const incomingId = await insertPerson(database, tenantId, sourceId, 'automatic-incoming', {
      name: 'Automatic Person',
      email: 'auto@example.com',
      phone: '+251911222333',
    });

    const outcome = await resolveRecord(prisma, resolution, tenantId, incomingId);

    expect(outcome).toMatchObject({
      entity_id: entityId,
      matched_against: entityId,
      decision: 'AUTO_MATCH',
      confidence: 1,
      explanation: {
        candidate_count: 1,
        features: { email_exact: true, phone_exact: true },
        contradictions: [],
      },
      algorithm_version: 'rules-0.1.0',
    });
    expect(await prisma.entityRecordLink.count({ where: { tenantId, entityId } })).toBe(2);
    expect(
      await prisma.matchFeature.count({ where: { tenantId, sourceRecordId: incomingId } }),
    ).toBe(1);
  });

  it('creates an open review case without linking the incoming record', async () => {
    const tenantId = await insertTenant(database, 'Review Tenant');
    const sourceId = await insertSource(database, tenantId);
    const candidateRecordId = await insertPerson(database, tenantId, sourceId, 'review-candidate', {
      name: 'Review Person',
      phone: '+251911000001',
      address: { city: 'Addis Ababa', country: 'ET' },
    });
    const entityId = await insertLinkedEntity(database, tenantId, candidateRecordId);
    const incomingId = await insertPerson(database, tenantId, sourceId, 'review-incoming', {
      name: 'Review Person',
      phone: '+251911000002',
      address: { city: 'Addis Ababa', country: 'ET' },
    });

    const outcome = await resolveRecord(prisma, resolution, tenantId, incomingId);

    expect(outcome).toMatchObject({
      entity_id: entityId,
      matched_against: entityId,
      decision: 'REVIEW',
      confidence: 0.85,
      explanation: {
        candidate_count: 1,
        features: { phone_exact: false, name_jaro_winkler_similarity: 1 },
        contradictions: [{ code: 'PHONE_CONFLICT', severity: 'warning' }],
      },
    });
    expect(
      await prisma.entityRecordLink.count({ where: { tenantId, sourceRecordId: incomingId } }),
    ).toBe(0);
    expect(
      await prisma.reviewCase.count({
        where: { tenantId, sourceRecordId: incomingId, status: 'OPEN' },
      }),
    ).toBe(1);
  });

  it('creates a review case when more than one entity can auto-match', async () => {
    const tenantId = await insertTenant(database, 'Ambiguous Match Tenant');
    const sourceId = await insertSource(database, tenantId);
    for (const suffix of ['a', 'b']) {
      const candidateId = await insertPerson(
        database,
        tenantId,
        sourceId,
        'ambiguous-candidate-' + suffix,
        { email: 'ambiguous@example.com' },
      );
      await insertLinkedEntity(database, tenantId, candidateId);
    }
    const incomingId = await insertPerson(database, tenantId, sourceId, 'ambiguous-incoming', {
      email: 'ambiguous@example.com',
    });

    const outcome = await resolveRecord(prisma, resolution, tenantId, incomingId);

    expect(outcome).toMatchObject({
      decision: 'REVIEW',
      confidence: 1,
      explanation: {
        candidate_count: 2,
        contradictions: [
          {
            code: 'MULTIPLE_AUTO_MATCH_CANDIDATES',
            severity: 'blocking',
          },
        ],
      },
    });
    expect(
      await prisma.matchFeature.count({ where: { tenantId, sourceRecordId: incomingId } }),
    ).toBe(2);
    expect(
      await prisma.entityRecordLink.count({ where: { tenantId, sourceRecordId: incomingId } }),
    ).toBe(0);
    expect(await prisma.reviewCase.count({ where: { tenantId, sourceRecordId: incomingId } })).toBe(
      1,
    );
  });
});

async function resolveRecord(
  prisma: ResolvePrismaClient,
  service: ResolutionService,
  tenantId: string,
  sourceRecordId: string,
): Promise<ResolutionExecution> {
  return prisma.$transaction((transaction) =>
    service.resolve(transaction, tenantId, sourceRecordId),
  );
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
    [tenantId, 'source-' + crypto.randomUUID()],
  );
  return result.rows[0]!.id;
}

async function insertPerson(
  database: Client,
  tenantId: string,
  sourceId: string,
  externalId: string,
  rawPayload: Record<string, unknown>,
): Promise<string> {
  const normalized = normalizeRecord(EntityType.Person, rawPayload);
  const result = await database.query<{ id: string }>(
    `INSERT INTO source_records
       (tenant_id, source_system_id, external_id, entity_type, raw_payload,
        normalized_payload, normalization_version, normalized_email,
        normalized_phone, company_domain, normalized_name_prefix)
     VALUES ($1, $2, $3, 'PERSON', $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      tenantId,
      sourceId,
      externalId,
      JSON.stringify(rawPayload),
      JSON.stringify(normalized.normalized_payload),
      normalized.normalization_version,
      normalized.normalized_email,
      normalized.normalized_phone,
      normalized.company_domain,
      normalized.normalized_name_prefix,
    ],
  );
  return result.rows[0]!.id;
}

async function insertLinkedEntity(
  database: Client,
  tenantId: string,
  sourceRecordId: string,
): Promise<string> {
  const entity = await database.query<{ id: string }>(
    `INSERT INTO entities (tenant_id, entity_type)
     VALUES ($1, 'PERSON') RETURNING id`,
    [tenantId],
  );
  const entityId = entity.rows[0]!.id;
  await database.query(
    `INSERT INTO entity_record_links
       (tenant_id, entity_id, source_record_id, score, decision, algorithm_version)
     VALUES ($1, $2, $3, 1.0000, 'NO_MATCH', 'rules-0.1.0')`,
    [tenantId, entityId, sourceRecordId],
  );
  return entityId;
}
