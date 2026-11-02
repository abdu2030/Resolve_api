import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { jest } from '@jest/globals';
import { createPrismaClient, type ResolvePrismaClient } from '@resolve/database';
import type { EntityOperationResult, RecordIngestionResult } from '@resolve/contracts';
import { Client } from 'pg';
import request from 'supertest';
import type { ResolveApplication } from '../../apps/api/src/application.js';
import { hashApiKey } from '../../apps/api/src/auth/api-key.js';
import { CanonicalizationService } from '../../apps/api/src/canonicalization/canonicalization.service.js';

function operationBody(response: request.Response): EntityOperationResult {
  return response.body as EntityOperationResult;
}
interface SwaggerOperation {
  parameters: unknown[];
  responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }>;
  requestBody: { content: Record<string, { schema: { oneOf: unknown[] } }> };
}

describe('Week 2 Day 5 entity operations HTTP', () => {
  const schema = `resolve_day5_operations_${process.pid}_${Date.now()}`;
  const base = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  base.searchParams.delete('schema');
  const database = new Client({ connectionString: base.toString() });
  const savedEnvironment = { ...process.env };
  let prisma: ResolvePrismaClient;
  let app: ResolveApplication;
  let server: Server;
  let tenantId: string;
  let actorId: string;
  let token: string;
  let sourceId: string;
  beforeAll(async () => {
    await database.connect();
    await database.query(`CREATE SCHEMA "${schema}"`);
    await database.query(`SET search_path TO "${schema}"`);
    const migrations = resolve('packages/database/prisma/migrations');
    for (const directory of (await readdir(migrations)).filter((name) => /^\d/.test(name)).sort())
      await database.query(await readFile(resolve(migrations, directory, 'migration.sql'), 'utf8'));
    const isolated = new URL(base);
    isolated.searchParams.set('schema', schema);
    prisma = createPrismaClient(isolated.toString());
    Object.assign(process.env, {
      DATABASE_URL: isolated.toString(),
      NODE_ENV: 'test',
      API_PORT: '3000',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      REQUEST_BODY_LIMIT: '1mb',
    });
    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });
  beforeEach(async () => {
    tenantId = (await prisma.tenant.create({ data: { name: 'Operations' } })).id;
    token = `rslv_test_${randomUUID().replaceAll('-', '').slice(0, 12)}.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789`;
    actorId = await key(token, [
      'records:write',
      'entities:read',
      'entities:merge',
      'entities:split',
    ]);
    sourceId = (await prisma.sourceSystem.create({ data: { tenantId, name: 'crm', type: 'api' } }))
      .id;
  });
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.end();
    for (const name of Object.keys(process.env))
      if (!(name in savedEnvironment)) delete process.env[name];
    Object.assign(process.env, savedEnvironment);
  });
  async function key(value: string, scopes: string[], revokedAt?: Date): Promise<string> {
    return (
      await prisma.apiKey.create({
        data: {
          tenantId,
          name: 'Operation actor',
          prefix: value.split('.')[0]!,
          keyHash: hashApiKey(value),
          scopes,
          revokedAt,
        },
      })
    ).id;
  }
  async function ingest(
    data: Record<string, unknown> = { name: randomUUID() },
    externalId = randomUUID(),
    type = 'person',
  ): Promise<RecordIngestionResult & { entity_id: string }> {
    const response = await request(server)
      .post('/v1/records')
      .auth(token, { type: 'bearer' })
      .send({ source: 'crm', external_id: externalId, entity_type: type, data });
    expect([200, 201]).toContain(response.status);
    return response.body as RecordIngestionResult & { entity_id: string };
  }
  async function version(id: string): Promise<number> {
    return (await prisma.entity.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id } } }))
      .canonicalVersion;
  }
  async function merge(
    source: string,
    target: string,
    idempotencyKey = randomUUID(),
  ): Promise<request.Response> {
    return post(
      target,
      'merge',
      {
        source_entity_id: source,
        expected_source_version: await version(source),
        expected_target_version: await version(target),
        reason: ' Confirmed duplicate ',
      },
      idempotencyKey,
    );
  }
  function post(
    id: string,
    action: string,
    body: unknown,
    idempotencyKey = randomUUID(),
    auth = token,
  ): request.Test {
    return request(server)
      .post(`/v1/entities/${id}/${action}`)
      .auth(auth, { type: 'bearer' })
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }
  async function state(): Promise<unknown> {
    const rows = await database.query<{ state: unknown }>(
      `SELECT jsonb_build_object(
      'entities',(SELECT jsonb_agg(e ORDER BY id) FROM entities e WHERE tenant_id=$1),
      'links',(SELECT jsonb_agg(l ORDER BY id) FROM entity_record_links l WHERE tenant_id=$1),
      'events',(SELECT jsonb_agg(o ORDER BY id) FROM entity_operations o WHERE tenant_id=$1),
      'history',(SELECT jsonb_agg(v ORDER BY id) FROM entity_canonical_versions v WHERE tenant_id=$1),
      'provenance',(SELECT jsonb_agg(p ORDER BY id) FROM entity_field_provenance p WHERE tenant_id=$1),
      'ledger',(SELECT jsonb_agg(i ORDER BY id) FROM idempotency_requests i WHERE tenant_id=$1)) AS state`,
      [tenantId],
    );
    return rows.rows[0]!.state;
  }
  async function denied(
    id: string,
    action: string,
    body: unknown,
    status: number,
    code: string,
    idempotencyKey = randomUUID(),
  ): Promise<void> {
    const before = await state();
    const response = await post(id, action, body, idempotencyKey);
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ error: { code } });
    expect(await state()).toEqual(before);
  }
  it('merges Person links with immutable source truth and readable shell/history', async () => {
    const sourceData = {
      name: 'Original Alpha',
      email: 'alpha@example.com',
      phone: '+251922334455',
      address: { city: 'Addis Ababa' },
    };
    const a = await ingest(sourceData);
    const auto = await ingest(sourceData);
    expect(auto).toMatchObject({ entity_id: a.entity_id, decision: 'AUTO_MATCH' });
    const b = await ingest({ name: 'Original Beta' });
    const reviewFeature = await prisma.matchFeature.create({
      data: {
        tenantId,
        sourceRecordId: b.record_id,
        candidateSourceRecordId: a.record_id,
        candidateEntityId: a.entity_id,
        featureVersion: 'features-v1',
        algorithmVersion: 'rules-v1',
        scoreInputs: {},
        explanation: { features: {}, contradictions: [] },
        score: 0.8,
        decision: 'REVIEW',
      },
    });
    await prisma.reviewCase.create({
      data: {
        tenantId,
        sourceRecordId: b.record_id,
        candidateSourceRecordId: a.record_id,
        candidateEntityId: a.entity_id,
        matchFeatureId: reviewFeature.id,
        score: 0.8,
        explanation: { features: {}, contradictions: [] },
        algorithmVersion: 'rules-v1',
      },
    });
    const features = await prisma.matchFeature.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    });
    const reviews = await prisma.reviewCase.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    });
    const sourceVersion = await version(a.entity_id);
    const records = await prisma.sourceRecord.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    });
    const rawVersions = await prisma.sourceRecordVersion.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    });
    const links = await prisma.entityRecordLink.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    });
    const history = await prisma.entityCanonicalVersion.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    });
    const reason = '\u{1f600}'.repeat(500);
    const body = {
      source_entity_id: a.entity_id,
      expected_source_version: sourceVersion,
      expected_target_version: await version(b.entity_id),
      reason: ` ${reason} `,
    };
    const beforeInvalidReason = await state();
    expect(
      (await post(b.entity_id, 'merge', { ...body, reason: reason + '\u{1f600}' })).status,
    ).toBe(400);
    expect(await state()).toEqual(beforeInvalidReason);
    const response = await post(b.entity_id, 'merge', body);
    expect(response.status).toBe(200);
    const event = response.body as EntityOperationResult;
    expect(
      await prisma.entityCanonicalVersion.count({
        where: { tenantId, entityOperationId: event.operation_id, triggerOperation: 'MERGE' },
      }),
    ).toBe(2);
    expect(event).toMatchObject({
      operation: 'MERGE',
      actor_api_key_id: actorId,
      reason,
      record_ids: [a.record_id, auto.record_id].sort(),
      source_version_before: sourceVersion,
      source_version_after: sourceVersion + 1,
      target_version_after: 2,
    });
    expect(
      await prisma.sourceRecord.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    ).toEqual(records);
    expect(
      await prisma.sourceRecordVersion.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    ).toEqual(rawVersions);
    expect(
      await prisma.matchFeature.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    ).toEqual(features);
    expect(
      await prisma.reviewCase.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    ).toEqual(reviews);
    for (const link of links)
      expect(await prisma.entityRecordLink.findUnique({ where: { id: link.id } })).toMatchObject({
        id: link.id,
        score: link.score,
        decision: link.decision,
        algorithmVersion: link.algorithmVersion,
        explanation: link.explanation,
        createdAt: link.createdAt,
        entityId: b.entity_id,
      });
    for (const snapshot of history)
      expect(
        await prisma.entityCanonicalVersion.findUnique({ where: { id: snapshot.id } }),
      ).toEqual(snapshot);
    const shell = await request(server)
      .get(`/v1/entities/${a.entity_id}`)
      .auth(token, { type: 'bearer' });
    expect(shell.status).toBe(200);
    expect(shell.body).toMatchObject({
      status: 'MERGED',
      merged_into_entity_id: b.entity_id,
      canonical_data: {},
      canonical_version: sourceVersion + 1,
    });
    const recordsResponse = await request(server)
      .get(`/v1/entities/${b.entity_id}/records`)
      .auth(token, { type: 'bearer' });
    expect((recordsResponse.body as { items: unknown[] }).items).toHaveLength(3);
    const historyResponse = await request(server)
      .get(`/v1/entities/${a.entity_id}/history`)
      .auth(token, { type: 'bearer' });
    expect((historyResponse.body as { items: unknown[] }).items[0]).toMatchObject({
      trigger: {
        operation: 'MERGE',
        source_record_id: null,
        entity_operation_id: event.operation_id,
      },
      entity_operation: event,
    });
  });
  it('splits selected Company records and replays normalized reordered UUID sets', async () => {
    const a = await ingest({ name: 'Company Alpha' }, randomUUID(), 'company');
    const b = await ingest({ name: 'Company Beta' }, randomUUID(), 'company');
    const c = await ingest({ name: 'Company Gamma' }, randomUUID(), 'company');
    expect((await merge(a.entity_id, c.entity_id)).status).toBe(200);
    expect((await merge(b.entity_id, c.entity_id)).status).toBe(200);
    const body = {
      record_ids: [a.record_id, b.record_id],
      expected_version: await version(c.entity_id),
      reason: 'Separate company',
    };
    const k = randomUUID();
    const response = await post(c.entity_id, 'split', body, k);
    expect(response.status).toBe(201);
    expect(
      await prisma.entityCanonicalVersion.count({
        where: {
          tenantId,
          entityOperationId: operationBody(response).operation_id,
          triggerOperation: 'SPLIT',
        },
      }),
    ).toBe(2);
    expect(response.body).toMatchObject({
      operation: 'SPLIT',
      source_entity_id: c.entity_id,
      target_version_before: 0,
      target_version_after: 1,
    });
    const before = await state();
    const replay = await post(
      c.entity_id.toUpperCase(),
      'split',
      { ...body, record_ids: [b.record_id.toUpperCase(), a.record_id.toUpperCase()] },
      k,
    );
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(response.body);
    expect(await state()).toEqual(before);
    await denied(
      c.entity_id,
      'split',
      { ...body, reason: 'Different' },
      409,
      'IDEMPOTENCY_KEY_REUSED',
      k,
    );
  });
  it('reverses into the original source using latest raw values while retaining unrelated target members', async () => {
    const external = randomUUID();
    const a = await ingest({ name: 'Original source', address: { city: 'Addis' } }, external);
    const targetData = { name: 'Target', email: 'target@example.com', phone: '+251911223344' };
    const b = await ingest(targetData);
    const merged = await merge(a.entity_id, b.entity_id);
    expect(merged.status).toBe(200);
    await ingest({ name: 'Latest source', address: { city: 'Nairobi' } }, external);
    const c = await ingest(targetData);
    expect(c.entity_id).toBe(b.entity_id);
    const response = await post(b.entity_id, 'split', {
      merge_event_id: operationBody(merged).operation_id,
      expected_version: await version(b.entity_id),
      reason: 'Reversal',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operation: 'UNMERGE',
      source_entity_id: b.entity_id,
      target_entity_id: a.entity_id,
      reversed_operation_id: operationBody(merged).operation_id,
    });
    const restored = await request(server)
      .get(`/v1/entities/${a.entity_id}`)
      .auth(token, { type: 'bearer' });
    expect(restored.body).toMatchObject({
      status: 'ACTIVE',
      canonical_data: { name: 'Latest source', address: { city: 'Nairobi' } },
    });
    const restoredBody = restored.body as {
      provenance: { address: { city: { source_record_id: string; raw_value: unknown } } };
    };
    expect(restoredBody.provenance.address.city).toMatchObject({
      source_record_id: a.record_id,
      raw_value: 'Nairobi',
    });
    const history = await request(server)
      .get(`/v1/entities/${a.entity_id}/history`)
      .auth(token, { type: 'bearer' });
    const snapshots = (
      history.body as {
        items: Array<{
          trigger: { operation: string };
          entity_operation: EntityOperationResult | null;
        }>;
      }
    ).items;
    expect(
      snapshots.find(
        (snapshot) =>
          snapshot.entity_operation?.operation_id === operationBody(merged).operation_id,
      )?.entity_operation,
    ).toEqual(operationBody(merged));
    expect(
      snapshots.find(
        (snapshot) =>
          snapshot.entity_operation?.operation_id === operationBody(response).operation_id,
      ),
    ).toMatchObject({ trigger: { operation: 'SPLIT' }, entity_operation: operationBody(response) });
    expect(
      await prisma.sourceRecordVersion.count({ where: { tenantId, sourceRecordId: a.record_id } }),
    ).toBe(2);
    expect(
      await prisma.entityRecordLink.count({ where: { tenantId, entityId: b.entity_id } }),
    ).toBe(2);
    await denied(
      b.entity_id,
      'split',
      {
        merge_event_id: operationBody(merged).operation_id,
        expected_version: await version(b.entity_id),
        reason: 'Again',
      },
      409,
      'MERGE_ALREADY_REVERSED',
    );
  });
  it('denies unauthorized actors and malformed payloads before any effects', async () => {
    const a = await ingest();
    const b = await ingest();
    const body = {
      source_entity_id: a.entity_id,
      expected_source_version: 1,
      expected_target_version: 1,
      reason: 'Manual',
    };
    const before = await state();
    expect(
      (await request(server).post(`/v1/entities/${b.entity_id}/merge`).send(body)).status,
    ).toBe(401);
    expect((await post(b.entity_id, 'merge', body, randomUUID(), 'invalid')).status).toBe(401);
    const wrong = 'rslv_test_820000000002.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
    await key(wrong, ['entities:split']);
    expect((await post(b.entity_id, 'merge', body, randomUUID(), wrong)).status).toBe(403);
    const mergeOnly = 'rslv_test_820000000003.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
    await key(mergeOnly, ['entities:merge']);
    expect(
      (
        await post(
          b.entity_id,
          'split',
          { record_ids: [a.record_id], expected_version: 1, reason: 'Manual' },
          randomUUID(),
          mergeOnly,
        )
      ).status,
    ).toBe(403);
    const revoked = 'rslv_test_820000000004.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
    await key(revoked, ['entities:merge'], new Date());
    expect((await post(b.entity_id, 'merge', body, randomUUID(), revoked)).status).toBe(401);
    const missingKey = await request(server)
      .post(`/v1/entities/${b.entity_id}/merge`)
      .auth(token, { type: 'bearer' })
      .send(body);
    expect(missingKey.status).toBe(400);
    expect(missingKey.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    expect((await post(b.entity_id, 'merge', body, 'bad key')).status).toBe(400);
    expect((await post('not-a-uuid', 'merge', body)).status).toBe(400);
    for (const invalid of [
      { record_ids: [], expected_version: 1, reason: 'Manual' },
      {
        record_ids: [a.record_id, a.record_id.toUpperCase()],
        expected_version: 1,
        reason: 'Manual',
      },
      {
        record_ids: [a.record_id],
        merge_event_id: randomUUID(),
        expected_version: 1,
        reason: 'Manual',
      },
      { expected_version: 1, reason: 'Manual' },
      { record_ids: null, expected_version: 1, reason: 'Manual' },
      { record_ids: [a.record_id], expected_version: 1, reason: '   ' },
      {
        record_ids: [a.record_id],
        expected_version: 1,
        reason: 'Manual',
        actor_api_key_id: actorId,
      },
      {
        record_ids: Array.from({ length: 1001 }, () => randomUUID()),
        expected_version: 1,
        reason: 'Manual',
      },
    ])
      expect((await post(b.entity_id, 'split', invalid)).status).toBe(400);
    expect(await state()).toEqual(before);
  });
  it('enforces self, type, version, active, empty and selected membership guards atomically', async () => {
    const a = await ingest();
    const b = await ingest();
    const company = await ingest({ name: 'Company' }, randomUUID(), 'company');
    const body = {
      source_entity_id: a.entity_id,
      expected_source_version: 1,
      expected_target_version: 1,
      reason: 'Manual',
    };
    await denied(a.entity_id.toUpperCase(), 'merge', body, 409, 'INVALID_ENTITY_MERGE');
    await denied(company.entity_id, 'merge', body, 409, 'ENTITY_TYPE_CONFLICT');
    await denied(
      b.entity_id,
      'merge',
      { ...body, expected_target_version: 0 },
      409,
      'ENTITY_VERSION_CONFLICT',
    );
    await denied(
      b.entity_id,
      'split',
      { record_ids: [b.record_id], expected_version: 1, reason: 'Manual' },
      409,
      'INVALID_ENTITY_SPLIT',
    );
    await denied(
      b.entity_id,
      'split',
      { record_ids: [a.record_id], expected_version: 1, reason: 'Manual' },
      404,
      'SOURCE_RECORD_NOT_FOUND',
    );
    await denied(
      b.entity_id,
      'split',
      { record_ids: [randomUUID()], expected_version: 1, reason: 'Manual' },
      404,
      'SOURCE_RECORD_NOT_FOUND',
    );
    const empty = await prisma.entity.create({ data: { tenantId, entityType: 'PERSON' } });
    await denied(
      b.entity_id,
      'merge',
      { ...body, source_entity_id: empty.id, expected_source_version: 0 },
      409,
      'INVALID_ENTITY_MERGE',
    );
    expect((await merge(a.entity_id, b.entity_id)).status).toBe(200);
    await denied(
      a.entity_id,
      'split',
      { record_ids: [a.record_id], expected_version: 2, reason: 'Manual' },
      409,
      'ENTITY_NOT_ACTIVE',
    );
    await denied(
      b.entity_id,
      'merge',
      { ...body, expected_source_version: 2, expected_target_version: 2 },
      409,
      'ENTITY_NOT_ACTIVE',
    );
  });
  it('hides foreign entities, events, records and input actors identically', async () => {
    const a = await ingest();
    const b = await ingest();
    const foreign = await prisma.tenant.create({ data: { name: 'Foreign' } });
    const foreignEntity = await prisma.entity.create({
      data: { tenantId: foreign.id, entityType: 'PERSON' },
    });
    const foreignRecord = await prisma.sourceRecord.create({
      data: {
        tenantId: foreign.id,
        sourceSystemId: (
          await prisma.sourceSystem.create({
            data: { tenantId: foreign.id, name: 'crm', type: 'api' },
          })
        ).id,
        externalId: 'foreign',
        entityType: 'PERSON',
        rawPayload: { name: 'Foreign' },
      },
    });
    const foreignActor = await prisma.apiKey.create({
      data: {
        tenantId: foreign.id,
        name: 'Foreign',
        prefix: randomUUID().slice(0, 24),
        keyHash: randomUUID(),
      },
    });
    const foreignTarget = await prisma.entity.create({
      data: { tenantId: foreign.id, entityType: 'PERSON' },
    });
    const event = await prisma.entityOperation.create({
      data: {
        tenantId: foreign.id,
        type: 'MERGE',
        sourceEntityId: foreignEntity.id,
        targetEntityId: foreignTarget.id,
        recordIds: [foreignRecord.id],
        reason: 'Foreign',
        actorApiKeyId: foreignActor.id,
        sourceVersionBefore: 0,
        sourceVersionAfter: 1,
        targetVersionBefore: 0,
        targetVersionAfter: 1,
      },
    });
    const body = {
      source_entity_id: a.entity_id,
      expected_source_version: 1,
      expected_target_version: 1,
      reason: 'Manual',
    };
    for (const id of [foreignEntity.id, randomUUID()])
      await denied(id, 'merge', body, 404, 'ENTITY_NOT_FOUND');
    await denied(
      b.entity_id,
      'merge',
      { ...body, source_entity_id: foreignEntity.id },
      404,
      'ENTITY_NOT_FOUND',
    );
    for (const id of [event.id, randomUUID()])
      await denied(
        b.entity_id,
        'split',
        { merge_event_id: id, expected_version: 1, reason: 'Manual' },
        404,
        'MERGE_EVENT_NOT_FOUND',
      );
    await denied(
      b.entity_id,
      'split',
      { record_ids: [foreignRecord.id], expected_version: 1, reason: 'Manual' },
      404,
      'SOURCE_RECORD_NOT_FOUND',
    );
    expect(
      (await post(b.entity_id, 'merge', { ...body, actor_api_key_id: foreignActor.id })).status,
    ).toBe(400);
    expect(operationBody(await merge(a.entity_id, b.entity_id)).actor_api_key_id).toBe(actorId);
  });
  it('rejects event wrong-mode/target and moved-away reversal members without partial effects', async () => {
    const a = await ingest();
    const b = await ingest();
    const c = await ingest();
    const merged = await merge(a.entity_id, b.entity_id);
    expect(merged.status).toBe(200);
    await denied(
      c.entity_id,
      'split',
      {
        merge_event_id: operationBody(merged).operation_id,
        expected_version: 1,
        reason: 'Wrong target',
      },
      404,
      'MERGE_EVENT_NOT_FOUND',
    );
    const split = await post(b.entity_id, 'split', {
      record_ids: [a.record_id],
      expected_version: 2,
      reason: 'Move away',
    });
    expect(split.status).toBe(201);
    await denied(
      b.entity_id,
      'split',
      {
        merge_event_id: operationBody(merged).operation_id,
        expected_version: 3,
        reason: 'Reverse',
      },
      409,
      'MERGE_REVERSAL_CONFLICT',
    );
    await denied(
      b.entity_id,
      'split',
      {
        merge_event_id: operationBody(split).operation_id,
        expected_version: 3,
        reason: 'Wrong mode',
      },
      404,
      'MERGE_EVENT_NOT_FOUND',
    );
    expect((await merge(b.entity_id, c.entity_id)).status).toBe(200);
    await denied(
      b.entity_id,
      'split',
      {
        merge_event_id: operationBody(merged).operation_id,
        expected_version: 4,
        reason: 'Newer merge',
      },
      409,
      'ENTITY_NOT_ACTIVE',
    );
    expect(await prisma.entityOperation.count({ where: { tenantId } })).toBe(3);
  });
  it('reverses merge chains in reverse order and preserves each retained identity', async () => {
    const a = await ingest();
    const b = await ingest();
    const c = await ingest();
    const first = await merge(a.entity_id, b.entity_id);
    expect(first.status).toBe(200);
    const second = await merge(b.entity_id, c.entity_id);
    expect(second.status).toBe(200);
    const restoredB = await post(c.entity_id, 'split', {
      merge_event_id: operationBody(second).operation_id,
      expected_version: await version(c.entity_id),
      reason: 'Reverse outer merge',
    });
    expect(restoredB.status).toBe(200);
    expect(operationBody(restoredB).target_entity_id).toBe(b.entity_id);
    const restoredA = await post(b.entity_id, 'split', {
      merge_event_id: operationBody(first).operation_id,
      expected_version: await version(b.entity_id),
      reason: 'Reverse inner merge',
    });
    expect(restoredA.status).toBe(200);
    expect(operationBody(restoredA).target_entity_id).toBe(a.entity_id);
    for (const entity of [a, b, c]) {
      expect(await prisma.entity.findUnique({ where: { id: entity.entity_id } })).toMatchObject({
        status: 'ACTIVE',
        mergedIntoEntityId: null,
      });
      expect(
        await prisma.entityRecordLink.findUnique({
          where: { tenantId_sourceRecordId: { tenantId, sourceRecordId: entity.record_id } },
        }),
      ).toMatchObject({ entityId: entity.entity_id });
    }
    expect(await prisma.entityOperation.count({ where: { tenantId } })).toBe(4);
  });
  it('prevents reversal that empties the target or overflows the restored entity version', async () => {
    const a = await ingest();
    const b = await ingest();
    const merged = await merge(a.entity_id, b.entity_id);
    expect(merged.status).toBe(200);
    await prisma.entity.update({
      where: { id: a.entity_id },
      data: { canonicalVersion: 2147483647 },
    });
    await denied(
      b.entity_id,
      'split',
      {
        merge_event_id: operationBody(merged).operation_id,
        expected_version: 2,
        reason: 'Overflow restored',
      },
      409,
      'ENTITY_VERSION_CONFLICT',
    );
    await prisma.entity.update({ where: { id: a.entity_id }, data: { canonicalVersion: 2 } });
    expect(
      (
        await post(b.entity_id, 'split', {
          record_ids: [b.record_id],
          expected_version: 2,
          reason: 'Move target member',
        })
      ).status,
    ).toBe(201);
    await denied(
      b.entity_id,
      'split',
      {
        merge_event_id: operationBody(merged).operation_id,
        expected_version: 3,
        reason: 'Would empty target',
      },
      409,
      'MERGE_REVERSAL_CONFLICT',
    );
  });
  it('replays merge across UUID casing and rejects cross-route key reuse; failures leave keys retryable', async () => {
    const a = await ingest();
    const b = await ingest();
    const k = randomUUID();
    const body = {
      source_entity_id: a.entity_id,
      expected_source_version: 1,
      expected_target_version: 1,
      reason: 'Manual',
    };
    await denied(
      b.entity_id,
      'merge',
      { ...body, expected_target_version: 0 },
      409,
      'ENTITY_VERSION_CONFLICT',
      k,
    );
    const result = await post(b.entity_id, 'merge', body, k);
    expect(result.status).toBe(200);
    const before = await state();
    const replay = await post(
      b.entity_id.toUpperCase(),
      'merge',
      { ...body, source_entity_id: a.entity_id.toUpperCase(), reason: ' Manual ' },
      k,
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(result.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(await state()).toEqual(before);
    await denied(
      b.entity_id,
      'split',
      { record_ids: [a.record_id], expected_version: 2, reason: 'Manual' },
      409,
      'IDEMPOTENCY_KEY_REUSED',
      k,
    );
    expect(
      (
        await request(server)
          .post('/v1/records')
          .auth(token, { type: 'bearer' })
          .set('Idempotency-Key', k)
          .send({
            source: 'crm',
            external_id: randomUUID(),
            entity_type: 'person',
            data: { name: 'New' },
          })
      ).status,
    ).toBe(409);
  });
  it('rejects exhausted versions and 1001 memberships before projection reads', async () => {
    const a = await ingest();
    const b = await ingest();
    await prisma.entity.update({
      where: { id: a.entity_id },
      data: { canonicalVersion: 2147483647 },
    });
    await denied(
      b.entity_id,
      'merge',
      {
        source_entity_id: a.entity_id,
        expected_source_version: 2147483647,
        expected_target_version: 1,
        reason: 'Overflow',
      },
      409,
      'ENTITY_VERSION_CONFLICT',
    );
    await prisma.entity.update({ where: { id: a.entity_id }, data: { canonicalVersion: 1 } });
    await database.query(
      `WITH added AS (INSERT INTO source_records (tenant_id,source_system_id,external_id,entity_type,raw_payload)
      SELECT $1,$2,'bound-'||n,'PERSON','{}'::jsonb FROM generate_series(1,1000) n RETURNING id)
      INSERT INTO entity_record_links (tenant_id,entity_id,source_record_id,score,decision,algorithm_version)
      SELECT $1,$3,id,0,'NO_MATCH','rules-v1' FROM added`,
      [tenantId, sourceId, a.entity_id],
    );
    await denied(
      b.entity_id,
      'merge',
      {
        source_entity_id: a.entity_id,
        expected_source_version: 1,
        expected_target_version: 1,
        reason: 'Bound',
      },
      422,
      'ENTITY_OPERATION_LIMIT',
    );
    await denied(
      a.entity_id,
      'split',
      { record_ids: [a.record_id], expected_version: 1, reason: 'Bound' },
      422,
      'ENTITY_OPERATION_LIMIT',
    );
  });
  it('rolls back a new split target, event, links, history and ledger when second projection fails, then retries', async () => {
    const a = await ingest();
    const b = await ingest();
    expect((await merge(a.entity_id, b.entity_id)).status).toBe(200);
    const before = await state();
    const k = randomUUID();
    const service = app.get(CanonicalizationService);
    const original = service.recomputeAfterEntityOperation.bind(service);
    let calls = 0;
    const spy = jest
      .spyOn(service, 'recomputeAfterEntityOperation')
      .mockImplementation(async (tx, input) => {
        calls += 1;
        if (calls === 2) throw new Error('Controlled canonicalization failure');
        await original(tx, input);
      });
    const body = { record_ids: [a.record_id], expected_version: 2, reason: 'Split' };
    try {
      const response = await post(b.entity_id, 'split', body, k);
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain('Controlled');
      expect(await state()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
    expect((await post(b.entity_id, 'split', body, k)).status).toBe(201);
  });
  function barrier(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((done) => {
      release = done;
    });
    return { promise, release };
  }
  async function waiter(mode: 'ShareLock' | 'ExclusiveLock'): Promise<void> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const result = await database.query<{ blocked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode=$2 AND NOT granted
        AND classid::bigint=((hashtextextended($1,0)>>32)&4294967295) AND objid::bigint=(hashtextextended($1,0)&4294967295)) AS blocked`,
        [`entity-membership:${tenantId}`, mode],
      );
      if (result.rows[0]!.blocked) return;
    }
    throw new Error(`Expected membership ${mode} waiter`);
  }
  it('serializes overlapping merges with one clean state conflict', async () => {
    const a = await ingest();
    const b = await ingest();
    const c = await ingest();
    const ready = barrier();
    const release = barrier();
    const service = app.get(CanonicalizationService);
    const original = service.recomputeAfterEntityOperation.bind(service);
    let held = false;
    const spy = jest
      .spyOn(service, 'recomputeAfterEntityOperation')
      .mockImplementation(async (tx, input) => {
        if (!held) {
          held = true;
          ready.release();
          await release.promise;
        }
        await original(tx, input);
      });
    const body = {
      source_entity_id: a.entity_id,
      expected_source_version: 1,
      expected_target_version: 1,
      reason: 'Concurrent',
    };
    const first = post(b.entity_id, 'merge', body).then((value) => value);
    let second: Promise<request.Response> | undefined;
    try {
      await ready.promise;
      second = post(c.entity_id, 'merge', body).then((value) => value);
      await waiter('ExclusiveLock');
    } finally {
      release.release();
      spy.mockRestore();
    }
    expect((await first).status).toBe(200);
    const conflict = await second;
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: 'ENTITY_NOT_ACTIVE' } });
    expect(await prisma.entityOperation.count({ where: { tenantId } })).toBe(1);
    expect(await prisma.entityRecordLink.count({ where: { tenantId } })).toBe(3);
    expect(
      await prisma.entityRecordLink.count({ where: { tenantId, entityId: b.entity_id } }),
    ).toBe(2);
  });
  it('waits for an ingestion shared gate and then validates its latest canonical version and membership', async () => {
    const external = randomUUID();
    const a = await ingest({ name: 'Before' }, external);
    const b = await ingest({ name: 'Target' });
    const ready = barrier();
    const release = barrier();
    const service = app.get(CanonicalizationService);
    const original = service.canonicalizeLinkedEntity.bind(service);
    const spy = jest
      .spyOn(service, 'canonicalizeLinkedEntity')
      .mockImplementation(async (tx, input) => {
        ready.release();
        await release.promise;
        await original(tx, input);
      });
    const ingestion = ingest({ name: 'After', address: { city: 'Nairobi' } }, external);
    let mutation: Promise<request.Response> | undefined;
    try {
      await ready.promise;
      mutation = post(b.entity_id, 'merge', {
        source_entity_id: a.entity_id,
        expected_source_version: 2,
        expected_target_version: 1,
        reason: 'After ingestion',
      }).then((value) => value);
      await waiter('ExclusiveLock');
      expect(await prisma.entityOperation.count({ where: { tenantId } })).toBe(0);
    } finally {
      release.release();
      spy.mockRestore();
    }
    await ingestion;
    expect((await mutation).status).toBe(200);
    expect(
      await prisma.entityRecordLink.findUnique({
        where: { tenantId_sourceRecordId: { tenantId, sourceRecordId: a.record_id } },
      }),
    ).toMatchObject({ entityId: b.entity_id });
    const result = await request(server)
      .get(`/v1/entities/${b.entity_id}`)
      .auth(token, { type: 'bearer' });
    expect(
      (result.body as { canonical_data: { address: unknown } }).canonical_data.address,
    ).toEqual({ city: 'Nairobi' });
    expect(
      await prisma.entityCanonicalVersion.count({ where: { tenantId, entityId: a.entity_id } }),
    ).toBe(3);
  });
  it('holds ingestion behind a manual exclusive gate and resolves the moved link with current evidence', async () => {
    const external = randomUUID();
    const a = await ingest({ name: 'Before' }, external);
    const b = await ingest();
    const originalLink = await prisma.entityRecordLink.findUniqueOrThrow({
      where: { tenantId_sourceRecordId: { tenantId, sourceRecordId: a.record_id } },
    });
    const ready = barrier();
    const release = barrier();
    const service = app.get(CanonicalizationService);
    const original = service.recomputeAfterEntityOperation.bind(service);
    let held = false;
    const spy = jest
      .spyOn(service, 'recomputeAfterEntityOperation')
      .mockImplementation(async (tx, input) => {
        if (!held) {
          held = true;
          ready.release();
          await release.promise;
        }
        await original(tx, input);
      });
    const mutation = merge(a.entity_id, b.entity_id);
    let ingestion: ReturnType<typeof ingest> | undefined;
    try {
      await ready.promise;
      ingestion = ingest({ name: 'After move' }, external);
      await waiter('ShareLock');
      expect(
        (await prisma.sourceRecord.findUniqueOrThrow({ where: { id: a.record_id } }))
          .currentVersion,
      ).toBe(1);
    } finally {
      release.release();
      spy.mockRestore();
    }
    const event = await mutation;
    expect(event.status).toBe(200);
    const result = await ingestion;
    expect(result).toMatchObject({
      entity_id: b.entity_id,
      entity_operation_id: operationBody(event).operation_id,
      confidence: Number(originalLink.score),
      decision: originalLink.decision,
    });
    expect(
      await prisma.entityRecordLink.findUnique({ where: { id: originalLink.id } }),
    ).toMatchObject({
      entityId: b.entity_id,
      score: originalLink.score,
      decision: originalLink.decision,
      explanation: originalLink.explanation,
    });
    expect(
      await prisma.entityCanonicalVersion.count({ where: { tenantId, entityId: a.entity_id } }),
    ).toBe(2);
  });
  it('publishes the actual success, required-key, split-selector and error Swagger metadata', async () => {
    const response = await request(server).get('/docs-json');
    expect(response.status).toBe(200);
    const paths = (response.body as { paths: Record<string, { post: SwaggerOperation }> }).paths;
    for (const action of ['merge', 'split']) {
      const operation = paths[`/v1/entities/{entityId}/${action}`]!.post;
      expect(operation.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ in: 'header', name: 'Idempotency-Key', required: true }),
        ]),
      );
      for (const code of ['200', '400', '401', '403', '404', '409', '422', '500'])
        expect(operation.responses[code]).toBeDefined();
      expect(operation.responses['200']!.content['application/json']!.schema.$ref).toContain(
        'EntityOperationResponseDto',
      );
    }
    const split = paths['/v1/entities/{entityId}/split']!.post;
    expect(split.responses['201']).toBeDefined();
    expect(split.requestBody.content['application/json']!.schema.oneOf).toHaveLength(2);
  });
});
