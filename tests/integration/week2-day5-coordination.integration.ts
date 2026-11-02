import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { EntityType, ResolutionDecision } from '@resolve/contracts';
import { createPrismaClient, type Prisma, type ResolvePrismaClient } from '@resolve/database';
import { Client } from 'pg';

import { CandidateGenerationService } from '../../apps/api/src/blocking/candidate-generation.service.js';
import { exactEmailQuery } from '../../apps/api/src/blocking/blocking.queries.js';
import { CanonicalizationService } from '../../apps/api/src/canonicalization/canonicalization.service.js';
import { acquireEntityMembershipLock } from '../../apps/api/src/common/database/entity-membership-lock.js';
import { EntityQueryService } from '../../apps/api/src/entities/entity-query.service.js';
import { mapEntityOperation } from '../../apps/api/src/entities/entity-operation.mapper.js';
import { RecordIngestionService } from '../../apps/api/src/records/record-ingestion.service.js';
import type { RecordIngestionExecution } from '../../apps/api/src/records/record-response.dto.js';
import { ResolutionService } from '../../apps/api/src/resolution/resolution.service.js';

function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

describe('Week 2 Day 5 membership coordination and structural canonicalization', () => {
  const schema = `resolve_day5_coordination_${process.pid}_${Date.now()}`;
  const base = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  base.searchParams.delete('schema');
  const database = new Client({ connectionString: base.toString() });
  let prisma: ResolvePrismaClient;
  let tenantId: string;
  let actorId: string;
  const canonicalization = new CanonicalizationService();
  let ingestion: RecordIngestionService;
  let resolution: ResolutionService;
  let queries: EntityQueryService;

  beforeAll(async () => {
    await database.connect();
    await database.query(`CREATE SCHEMA "${schema}"`);
    await database.query(`SET search_path TO "${schema}"`);
    const migrations = resolve('packages/database/prisma/migrations');
    for (const directory of (await readdir(migrations)).filter((name) => /^\d/.test(name)).sort()) {
      await database.query(await readFile(resolve(migrations, directory, 'migration.sql'), 'utf8'));
    }
    const isolated = new URL(base);
    isolated.searchParams.set('schema', schema);
    prisma = createPrismaClient(isolated.toString());
    const tenant = await prisma.tenant.create({ data: { name: 'Coordination' } });
    tenantId = tenant.id;
    actorId = (
      await prisma.apiKey.create({
        data: {
          tenantId,
          name: 'Audit actor',
          prefix: 'coordination',
          keyHash: 'coordination-hash',
        },
      })
    ).id;
    await prisma.sourceSystem.create({ data: { tenantId, name: 'crm', type: 'api' } });
    const settings: Record<string, string | number> = {
      databaseUrl: isolated.toString(),
      blockingMaxCandidates: 2,
    };
    const candidates = new CandidateGenerationService(prisma, {
      get: (key: string) => settings[key],
    } as ConstructorParameters<typeof CandidateGenerationService>[1]);
    resolution = new ResolutionService(candidates);
    ingestion = new RecordIngestionService(prisma, resolution, canonicalization);
    queries = new EntityQueryService(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.end();
  });

  async function ingest(name: string, key?: string): Promise<RecordIngestionExecution> {
    return ingestion.ingest(
      tenantId,
      {
        source: 'crm',
        external_id: name,
        entity_type: EntityType.Person,
        data: { name },
      },
      { name },
      key,
    );
  }

  async function operation(
    sourceEntityId: string,
    targetEntityId: string,
    recordId: string,
  ): Promise<Prisma.EntityOperationGetPayload<Record<string, never>>> {
    return prisma.entityOperation.create({
      data: {
        tenantId,
        type: 'MERGE',
        sourceEntityId,
        targetEntityId,
        recordIds: [recordId],
        reason: 'Confirmed duplicate',
        actorApiKeyId: actorId,
        sourceVersionBefore: 1,
        sourceVersionAfter: 2,
        targetVersionBefore: 1,
        targetVersionAfter: 2,
      },
    });
  }

  async function requireBlockedSharedHolder(): Promise<void> {
    const identity = `entity-membership:${tenantId}`;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { rows } = await database.query<{ blocked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_locks
          WHERE locktype='advisory' AND mode='ShareLock' AND NOT granted
          AND classid::bigint = ((hashtextextended($1,0) >> 32) & 4294967295)
          AND objid::bigint = (hashtextextended($1,0) & 4294967295)) AS blocked`,
        [identity],
      );
      if (rows[0]!.blocked) return;
    }
    throw new Error('Expected a shared membership gate waiter');
  }

  it('replays before the gate and waits at the gate before ingestion writes', async () => {
    const original = await ingest('Gate replay', 'gate-replay-key');
    const ready = barrier();
    const release = barrier();
    const holder = prisma.$transaction(
      async (tx) => {
        await acquireEntityMembershipLock(tx, tenantId, 'exclusive');
        ready.release();
        await release.promise;
      },
      { timeout: 10000 },
    );
    await ready.promise;
    let pending: ReturnType<typeof ingest> | undefined;
    try {
      expect(await ingest('Gate replay', 'gate-replay-key')).toEqual({
        ...original,
        replayed: true,
      });
      pending = ingest('Gate blocked new record');
      await requireBlockedSharedHolder();
      expect(
        await prisma.sourceRecord.count({
          where: { tenantId, externalId: 'Gate blocked new record' },
        }),
      ).toBe(0);
    } finally {
      release.release();
      await holder;
      await pending;
    }
    expect(
      await prisma.sourceRecord.count({
        where: { tenantId, externalId: 'Gate blocked new record' },
      }),
    ).toBe(1);
  });

  it('gates independently invoked resolution before returning a stored link', async () => {
    const original = (await ingest('Independent resolution gate')).body;
    const ready = barrier();
    const release = barrier();
    const holder = prisma.$transaction(
      async (tx) => {
        await acquireEntityMembershipLock(tx, tenantId, 'exclusive');
        ready.release();
        await release.promise;
      },
      { timeout: 10000 },
    );
    await ready.promise;
    const pending = prisma.$transaction((tx) =>
      resolution.resolve(tx, tenantId, original.record_id),
    );
    try {
      await requireBlockedSharedHolder();
    } finally {
      release.release();
      await holder;
    }
    expect(await pending).toMatchObject({
      entity_id: original.entity_id,
      decision: ResolutionDecision.NoMatch,
    });
  });

  it('allows shared holders together, blocks exclusive until both release, and isolates tenants', async () => {
    const firstReady = barrier();
    const secondReady = barrier();
    const releaseFirst = barrier();
    const releaseSecond = barrier();
    const writerStarted = barrier();
    let writerPid = 0;
    const first = prisma.$transaction(
      async (tx) => {
        await acquireEntityMembershipLock(tx, tenantId, 'shared');
        firstReady.release();
        await releaseFirst.promise;
      },
      { timeout: 10000 },
    );
    await firstReady.promise;
    const second = prisma.$transaction(
      async (tx) => {
        await acquireEntityMembershipLock(tx, tenantId, 'shared');
        secondReady.release();
        await releaseSecond.promise;
      },
      { timeout: 10000 },
    );
    await secondReady.promise;
    const writer = prisma.$transaction(
      async (tx) => {
        writerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!
          .pid;
        writerStarted.release();
        await acquireEntityMembershipLock(tx, tenantId, 'exclusive');
      },
      { timeout: 10000 },
    );
    try {
      await writerStarted.promise;
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        blocked = (
          await database.query<{ blocked: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS blocked",
            [writerPid],
          )
        ).rows[0]!.blocked;
      }
      expect(blocked).toBe(true);
      await prisma.$transaction((tx) => acquireEntityMembershipLock(tx, randomUUID(), 'exclusive'));
      releaseFirst.release();
      await first;
      expect(
        (
          await database.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
            [`entity-membership:${tenantId}`],
          )
        ).rows[0]!.acquired,
      ).toBe(false);
    } finally {
      releaseFirst.release();
      releaseSecond.release();
      await Promise.all([first, second, writer]);
    }
  });

  it('forces structural snapshots for equal projection and clears merged shells without losing history', async () => {
    const source = (await ingest('Structural source')).body;
    const target = (await ingest('Structural target')).body;
    const event = await operation(source.entity_id, target.entity_id, source.record_id);
    const beforeLink = await prisma.entityRecordLink.findUniqueOrThrow({
      where: { tenantId_sourceRecordId: { tenantId, sourceRecordId: source.record_id } },
    });
    await prisma.$transaction(async (tx) => {
      await acquireEntityMembershipLock(tx, tenantId, 'exclusive');
      await tx.entityRecordLink.update({
        where: { id: beforeLink.id },
        data: {
          entityId: target.entity_id,
          lastEntityOperationId: event.id,
        },
      });
      await tx.entity.update({
        where: { id: source.entity_id },
        data: {
          status: 'MERGED',
          mergedIntoEntityId: target.entity_id,
        },
      });
      for (const entityId of [source.entity_id, target.entity_id].sort()) {
        await canonicalization.recomputeAfterEntityOperation(tx, {
          tenantId,
          entityId,
          entityOperationId: event.id,
          operation: 'MERGE',
        });
      }
    });
    const shell = await queries.getEntity(tenantId, source.entity_id);
    expect(shell).toMatchObject({
      status: 'MERGED',
      merged_into_entity_id: target.entity_id,
      canonical_data: {},
      provenance: {},
      canonical_version: 2,
      record_count: 0,
    });
    const history = await queries.listHistory(tenantId, source.entity_id, {});
    expect(history.items).toHaveLength(2);
    expect(history.items[0]).toMatchObject({
      trigger: {
        operation: 'MERGE',
        source_record_id: null,
        entity_operation_id: event.id,
      },
      entity_operation: {
        operation_id: event.id,
        record_ids: [source.record_id],
        operation: 'MERGE',
        actor_api_key_id: actorId,
        operation_version: 'entity-operations-v1',
      },
    });
    expect(history.items[1]).toMatchObject({
      trigger: { entity_operation_id: null },
      entity_operation: null,
    });
    const linked = await queries.listRecords(tenantId, target.entity_id, {});
    expect(linked.items.find((item) => item.record_id === source.record_id)?.link).toMatchObject({
      entity_operation_id: event.id,
      confidence: Number(beforeLink.score),
      explanation: beforeLink.explanation,
      decision: 'NO_MATCH',
    });

    const old = await prisma.entity.findUniqueOrThrow({ where: { id: target.entity_id } });
    await prisma.$transaction((tx) =>
      canonicalization.recomputeAfterEntityOperation(tx, {
        tenantId,
        entityId: target.entity_id,
        entityOperationId: event.id,
        operation: 'SPLIT',
      }),
    );
    const updated = await prisma.entity.findUniqueOrThrow({ where: { id: target.entity_id } });
    expect(updated.canonicalData).toEqual(old.canonicalData);
    expect(updated.canonicalVersion).toBe(old.canonicalVersion + 1);
    expect((await queries.listHistory(tenantId, target.entity_id, {})).items[0]).toMatchObject({
      trigger: { operation: 'SPLIT', source_record_id: null, entity_operation_id: event.id },
    });
  });

  it('returns current moved membership while preserving keyed historical replay and ingestion no-op history', async () => {
    const source = await ingest('Replay source', 'original-coordination-key');
    const target = await ingest('Replay target');
    const event = await operation(
      source.body.entity_id,
      target.body.entity_id,
      source.body.record_id,
    );
    await prisma.entityRecordLink.update({
      where: { tenantId_sourceRecordId: { tenantId, sourceRecordId: source.body.record_id } },
      data: { entityId: target.body.entity_id, lastEntityOperationId: event.id },
    });
    const fresh = await ingest('Replay source');
    expect(fresh.body).toMatchObject({
      entity_id: target.body.entity_id,
      entity_operation_id: event.id,
    });
    expect((await ingest('Replay source', 'original-coordination-key')).body).toEqual(source.body);
    expect(
      await prisma.entityCanonicalVersion.count({
        where: { tenantId, entityId: target.body.entity_id },
      }),
    ).toBe(1);
  });

  it('excludes invalid merged candidates while preserving ACTIVE matches and SQL bounds', async () => {
    const source = (await ingest('Candidate merged')).body;
    const target = (await ingest('Candidate active')).body;
    const incoming = (await ingest('Candidate incoming')).body;
    await prisma.sourceRecord.updateMany({
      where: { tenantId, id: { in: [source.record_id, target.record_id] } },
      data: { normalizedEmail: 'candidate@example.com' },
    });
    await prisma.entity.update({
      where: { id: source.entity_id },
      data: {
        status: 'MERGED',
        mergedIntoEntityId: target.entity_id,
      },
    });
    const rows = await prisma.$queryRaw<Array<{ entityId: string }>>(
      exactEmailQuery({
        schema,
        tenantId,
        sourceRecordId: incoming.record_id,
        entityType: 'PERSON',
        value: 'candidate@example.com',
        limit: 1,
      }),
    );
    expect(rows.map((row) => row.entityId)).toEqual([target.entity_id]);
  });

  it('maps operation metadata without camelCase leaks and rejects corrupted stored record IDs', async () => {
    const source = (await ingest('Mapper source')).body;
    const target = (await ingest('Mapper target')).body;
    const row = await operation(source.entity_id, target.entity_id, source.record_id);
    expect(mapEntityOperation(row)).toEqual({
      operation_id: row.id,
      operation: 'MERGE',
      operation_version: 'entity-operations-v1',
      source_entity_id: source.entity_id,
      target_entity_id: target.entity_id,
      record_ids: [source.record_id],
      reason: 'Confirmed duplicate',
      actor_api_key_id: actorId,
      source_version_before: 1,
      source_version_after: 2,
      target_version_before: 1,
      target_version_after: 2,
      reversed_operation_id: null,
      created_at: row.createdAt.toISOString(),
    });
    expect(() => mapEntityOperation({ ...row, recordIds: ['invalid'] })).toThrow();
    expect(() =>
      mapEntityOperation({ ...row, recordIds: Array.from({ length: 1001 }, () => randomUUID()) }),
    ).toThrow();
    expect(() =>
      mapEntityOperation({ ...row, recordIds: [source.record_id, source.record_id] }),
    ).toThrow();
    expect(() => mapEntityOperation({ ...row, operationVersion: 'future' })).toThrow();
  });
});
