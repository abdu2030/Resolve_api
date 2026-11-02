import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { jest } from '@jest/globals';
import { createPrismaClient, type ResolvePrismaClient } from '@resolve/database';
import type { RecordIngestionResult, ReviewDecisionResult } from '@resolve/contracts';
import { Client } from 'pg';
import request from 'supertest';
import type { ResolveApplication } from '../../apps/api/src/application.js';
import { hashApiKey } from '../../apps/api/src/auth/api-key.js';
import { CanonicalizationService } from '../../apps/api/src/canonicalization/canonicalization.service.js';
import { ResolutionService } from '../../apps/api/src/resolution/resolution.service.js';
import type {
  ReviewDetailDto,
  ReviewPageDto,
} from '../../apps/api/src/reviews/review-response.dto.js';

function body<T>(response: request.Response): T {
  return response.body as T;
}
function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

describe('Week 2 Day 6 review HTTP and persistence', () => {
  const schema = `resolve_day6_reviews_${process.pid}_${Date.now()}`;
  const base = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  base.searchParams.delete('schema');
  const db = new Client({ connectionString: base.toString() });
  const saved = { ...process.env };
  let prisma: ResolvePrismaClient;
  let app: ResolveApplication;
  let server: Server;
  let tenantId: string;
  let actorId: string;
  let token: string;

  beforeAll(async () => {
    await db.connect();
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    const root = resolve('packages/database/prisma/migrations');
    for (const directory of (await readdir(root)).filter((name) => /^\d/.test(name)).sort())
      await db.query(await readFile(resolve(root, directory, 'migration.sql'), 'utf8'));
    const url = new URL(base);
    url.searchParams.set('schema', schema);
    prisma = createPrismaClient(url.toString());
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
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
    tenantId = (await prisma.tenant.create({ data: { name: 'Review tenant' } })).id;
    token = `rslv_test_${randomUUID().replaceAll('-', '').slice(0, 12)}.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789`;
    actorId = await key(token, [
      'records:write',
      'entities:read',
      'entities:merge',
      'entities:split',
      'reviews:read',
      'reviews:write',
    ]);
    await prisma.sourceSystem.create({ data: { tenantId, name: 'crm', type: 'api' } });
  });
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  async function key(value: string, scopes: string[], revokedAt?: Date): Promise<string> {
    return (
      await prisma.apiKey.create({
        data: {
          tenantId,
          name: 'Reviewer',
          prefix: value.split('.')[0]!,
          keyHash: hashApiKey(value),
          scopes,
          revokedAt,
        },
      })
    ).id;
  }
  function get(path: string, auth = token): request.Test {
    return request(server).get(`/v1/reviews${path}`).auth(auth, { type: 'bearer' });
  }
  function post(
    id: string,
    input: unknown,
    idempotencyKey: string | undefined = randomUUID(),
    auth = token,
  ): request.Test {
    const call = request(server).post(`/v1/reviews/${id}/decision`).auth(auth, { type: 'bearer' });
    if (idempotencyKey !== undefined) call.set('Idempotency-Key', idempotencyKey);
    return call.send(input);
  }
  async function ingest(
    data: Record<string, unknown>,
    externalId = randomUUID(),
    idem?: string,
    type = 'person',
  ): Promise<RecordIngestionResult> {
    const call = request(server).post('/v1/records').auth(token, { type: 'bearer' });
    if (idem) call.set('Idempotency-Key', idem);
    const response = await call.send({
      source: 'crm',
      external_id: externalId,
      entity_type: type,
      data,
    });
    expect([200, 201]).toContain(response.status);
    return body<RecordIngestionResult>(response);
  }
  async function pair(): Promise<{
    reviewId: string;
    candidate: RecordIngestionResult;
    incoming: RecordIngestionResult;
    data: Record<string, unknown>;
    external: string;
    originalKey: string;
  }> {
    const suffix = randomUUID().slice(0, 8);
    const digits = String(parseInt(suffix, 16) % 1000000).padStart(6, '0');
    const address = { city: `Addis ${suffix}`, country: 'ET' };
    const candidate = await ingest({
      name: `Review ${suffix}`,
      phone: `+251911${digits}`,
      address,
    });
    const data = { name: `Review ${suffix}`, phone: `+251922${digits}`, address };
    const external = randomUUID();
    const originalKey = randomUUID();
    const incoming = await ingest(data, external, originalKey);
    expect(incoming.decision).toBe('REVIEW');
    const review = await prisma.reviewCase.findUniqueOrThrow({
      where: { tenantId_sourceRecordId: { tenantId, sourceRecordId: incoming.record_id } },
    });
    expect(review).toMatchObject({ sourceRecordVersion: 1, candidateRecordVersion: 1 });
    return { reviewId: review.id, candidate, incoming, data, external, originalKey };
  }
  async function input(id: string, decision = 'APPROVE'): Promise<Record<string, unknown>> {
    const response = await get(`/${id}`);
    expect(response.status).toBe(200);
    const detail = body<ReviewDetailDto>(response);
    return {
      decision,
      reason: 'Confirmed by reviewer',
      expected_source_version: detail.source_record.current_version,
      expected_candidate_version: detail.candidate_entity.canonical_version,
    };
  }
  async function state(): Promise<unknown> {
    return (
      await db.query<{ value: unknown }>(
        `SELECT jsonb_build_object(
      'entities',(SELECT jsonb_agg(e ORDER BY id) FROM entities e WHERE tenant_id=$1),
      'links',(SELECT jsonb_agg(l ORDER BY id) FROM entity_record_links l WHERE tenant_id=$1),
      'reviews',(SELECT jsonb_agg(r ORDER BY id) FROM review_cases r WHERE tenant_id=$1),
      'decisions',(SELECT jsonb_agg(d ORDER BY id) FROM review_decisions d WHERE tenant_id=$1),
      'history',(SELECT jsonb_agg(h ORDER BY id) FROM entity_canonical_versions h WHERE tenant_id=$1),
      'ledger',(SELECT jsonb_agg(i ORDER BY id) FROM idempotency_requests i WHERE tenant_id=$1)) AS value`,
        [tenantId],
      )
    ).rows[0]!.value;
  }
  async function denied(id: string, value: unknown, code: string, status = 409): Promise<void> {
    const before = await state();
    const response = await post(id, value);
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ error: { code } });
    expect(await state()).toEqual(before);
  }
  it('lists bounded tenant-local cases, inspects immutable evidence, and paginates ties', async () => {
    const a = await pair();
    const b = await pair();
    await prisma.reviewCase.updateMany({
      where: { tenantId },
      data: { createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    const first = body<ReviewPageDto>(await get('?limit=1'));
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const second = body<ReviewPageDto>(await get(`?limit=1&cursor=${first.next_cursor}`));
    expect(new Set([...first.items, ...second.items].map((item) => item.review_id))).toEqual(
      new Set([a.reviewId, b.reviewId]),
    );
    expect(second.next_cursor).toBeNull();
    const detail = body<ReviewDetailDto>(await get(`/${a.reviewId}`));
    expect(detail).toMatchObject({
      approval_available: true,
      human_decision: null,
      source_record: { evidence_version: 1, evidence_raw_payload: a.data },
    });
    expect(detail.evidence).toHaveProperty('score_inputs');
    expect(detail.evidence).toHaveProperty('scoring_explanation');
    expect((await get('?limit=101')).status).toBe(400);
    expect((await get('?status=RESOLVED&cursor=' + first.next_cursor)).status).toBe(400);
    expect((await get('?tenant_id=other')).status).toBe(400);
  });
  it.each(['APPROVE', 'REJECT'])(
    'applies %s atomically, preserves evidence, and replays safely',
    async (outcome) => {
      const p = await pair();
      const value = { ...(await input(p.reviewId, outcome)), reason: ` ${'😀'.repeat(500)} ` };
      const idem = randomUUID();
      const evidence = await prisma.matchFeature.findMany({ where: { tenantId } });
      const raw = await prisma.sourceRecordVersion.findMany({
        where: { tenantId },
        orderBy: { id: 'asc' },
      });
      const response = await post(p.reviewId, value, idem);
      expect(response.status).toBe(200);
      const result = body<ReviewDecisionResult>(response);
      expect(result).toMatchObject({
        decision: outcome,
        reason: '😀'.repeat(500),
        actor_api_key_id: actorId,
        source_record_version: 1,
        policy_version: 'review-v1',
      });
      if (outcome === 'APPROVE') expect(result.entity_id).toBe(p.candidate.entity_id);
      else expect(result.entity_id).not.toBe(p.candidate.entity_id);
      const after = await state();
      const replay = await post(
        p.reviewId.toUpperCase(),
        { ...value, reason: result.reason },
        idem,
      );
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toEqual(response.body);
      expect(await state()).toEqual(after);
      expect(await prisma.matchFeature.findMany({ where: { tenantId } })).toEqual(evidence);
      expect(
        await prisma.sourceRecordVersion.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
      ).toEqual(raw);
      const link = await prisma.entityRecordLink.findUniqueOrThrow({
        where: { tenantId_sourceRecordId: { tenantId, sourceRecordId: p.incoming.record_id } },
      });
      expect(link).toMatchObject({
        decision: 'REVIEW',
        reviewDecisionId: result.review_decision_id,
        algorithmVersion: p.incoming.algorithm_version,
      });
      expect(Number(link.score)).toBe(p.incoming.confidence);
      const historyResponse = await request(server)
        .get(`/v1/entities/${result.entity_id}/history`)
        .auth(token, { type: 'bearer' });
      const history = body<{ items: { trigger: unknown; review_decision: unknown }[] }>(
        historyResponse,
      );
      expect(history.items[0]).toMatchObject({
        trigger: {
          operation: outcome === 'APPROVE' ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED',
          review_decision_id: result.review_decision_id,
        },
        review_decision: result,
      });
      const latest = await ingest(p.data, p.external);
      expect(latest).toMatchObject({
        entity_id: result.entity_id,
        decision: outcome === 'APPROVE' ? 'AUTO_MATCH' : 'NO_MATCH',
        review_decision_id: result.review_decision_id,
      });
      expect(await ingest(p.data, p.external, p.originalKey)).toEqual(p.incoming);
      await denied(p.reviewId, value, 'REVIEW_ALREADY_RESOLVED');
      const conflict = await post(p.reviewId, { ...value, reason: 'Different' }, idem);
      expect(conflict.status).toBe(409);
      expect(body<ReviewPageDto>(await get('')).items).toHaveLength(0);
      expect(body<ReviewPageDto>(await get('?status=RESOLVED')).items).toHaveLength(1);
    },
  );
  it('rejects stale evidence approval but permits safe rejection using current source values', async () => {
    const p = await pair();
    const old = await input(p.reviewId);
    const updated = { ...p.data, name: 'Changed after scoring' };
    await ingest(updated, p.external);
    await denied(p.reviewId, old, 'REVIEW_SOURCE_VERSION_CONFLICT');
    await denied(p.reviewId, await input(p.reviewId), 'REVIEW_EVIDENCE_STALE');
    const detail = body<ReviewDetailDto>(await get(`/${p.reviewId}`));
    expect(detail).toMatchObject({
      approval_available: false,
      source_record: { raw_payload: updated, evidence_raw_payload: p.data },
    });
    const response = await post(p.reviewId, await input(p.reviewId, 'REJECT'));
    expect(response.status).toBe(200);
    const entity = await prisma.entity.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: body<ReviewDecisionResult>(response).entity_id } },
    });
    expect(entity.canonicalData).toMatchObject({ name: 'Changed after scoring' });
  });
  it('refuses a changed supporting record or stale canonical version', async () => {
    const p = await pair();
    const old = await input(p.reviewId);
    const candidate = await prisma.sourceRecord.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: p.candidate.record_id } },
    });
    await ingest({ name: 'Changed candidate' }, candidate.externalId);
    await denied(p.reviewId, old, 'REVIEW_EVIDENCE_STALE');
    const q = await pair();
    await denied(
      q.reviewId,
      { ...(await input(q.reviewId)), expected_candidate_version: 0 },
      'ENTITY_VERSION_CONFLICT',
    );
  });
  it('refuses merged candidates and moved supporting membership after split', async () => {
    const p = await pair();
    const target = await ingest({ name: randomUUID() });
    const merged = await request(server)
      .post(`/v1/entities/${target.entity_id}/merge`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({
        source_entity_id: p.candidate.entity_id,
        expected_source_version: 1,
        expected_target_version: 1,
        reason: 'Later merge',
      });
    expect(merged.status).toBe(200);
    await denied(p.reviewId, await input(p.reviewId), 'REVIEW_EVIDENCE_STALE');
    const q = await pair();
    const extra = await prisma.sourceRecord.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: q.candidate.record_id } },
    });
    await ingest(extra.rawPayload as Record<string, unknown>);
    const version = (
      await prisma.entity.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: q.candidate.entity_id } },
      })
    ).canonicalVersion;
    const split = await request(server)
      .post(`/v1/entities/${q.candidate.entity_id}/split`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({
        record_ids: [q.candidate.record_id],
        expected_version: version,
        reason: 'Later split',
      });
    expect(split.status).toBe(201);
    await denied(q.reviewId, await input(q.reviewId), 'REVIEW_EVIDENCE_STALE');
  });
  it('denies missing/revoked keys, wrong scopes, foreign IDs, and untrusted actors', async () => {
    const p = await pair();
    const value = await input(p.reviewId);
    expect((await request(server).get('/v1/reviews')).status).toBe(401);
    expect((await get('', 'invalid')).status).toBe(401);
    const read = `rslv_test_${randomUUID().slice(0, 8)}.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789`;
    await key(read, ['reviews:read']);
    expect((await post(p.reviewId, value, randomUUID(), read)).status).toBe(403);
    const write = `rslv_test_${randomUUID().slice(0, 8)}.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789`;
    const writeId = await key(write, ['reviews:write']);
    expect((await get('', write)).status).toBe(403);
    await prisma.apiKey.update({ where: { id: writeId }, data: { revokedAt: new Date() } });
    expect((await post(p.reviewId, value, randomUUID(), write)).status).toBe(401);
    const foreignTenant = (await prisma.tenant.create({ data: { name: 'Other tenant' } })).id;
    const foreign = `rslv_test_${randomUUID().slice(0, 8)}.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789`;
    await prisma.apiKey.create({
      data: {
        tenantId: foreignTenant,
        name: 'Foreign',
        prefix: foreign.split('.')[0]!,
        keyHash: hashApiKey(foreign),
        scopes: ['reviews:read', 'reviews:write'],
      },
    });
    expect(body<ReviewPageDto>(await get('', foreign)).items).toEqual([]);
    const hidden = await get(`/${p.reviewId}`, foreign);
    expect(hidden.status).toBe(404);
    const absent = await get(`/${randomUUID()}`, foreign);
    expect(absent.body).toEqual(hidden.body);
    expect((await post(p.reviewId, value, randomUUID(), foreign)).status).toBe(404);
    await denied(p.reviewId, { ...value, actor_api_key_id: actorId }, 'BAD_REQUEST', 400);
  });
  it('rejects malformed input and missing keys without state changes', async () => {
    const p = await pair();
    const value = await input(p.reviewId);
    const before = await state();
    const missing = await request(server)
      .post(`/v1/reviews/${p.reviewId}/decision`)
      .auth(token, { type: 'bearer' })
      .send(value);
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    for (const change of [
      { decision: 'MATCH' },
      { reason: ' ' },
      { reason: '😀'.repeat(501) },
      { expected_source_version: '1' },
      { tenant_id: tenantId },
    ])
      expect((await post(p.reviewId, { ...value, ...change })).status).toBe(400);
    expect((await post(p.reviewId, value, 'invalid key')).status).toBe(400);
    expect((await get('/bad-id')).status).toBe(400);
    expect(await state()).toEqual(before);
  });
  it('rolls back outcome, link, new entity, history, and idempotency on canonical failure', async () => {
    const p = await pair();
    const value = await input(p.reviewId, 'REJECT');
    const idem = randomUUID();
    const before = await state();
    const spy = jest
      .spyOn(app.get(CanonicalizationService), 'canonicalizeAfterReview')
      .mockRejectedValueOnce(new Error('Controlled failure'));
    try {
      expect((await post(p.reviewId, value, idem)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await state()).toEqual(before);
    expect((await post(p.reviewId, value, idem)).status).toBe(200);
  });
  async function waitForGate(mode: 'ShareLock' | 'ExclusiveLock'): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await db.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode=$2 AND NOT granted
        AND classid::bigint=((hashtextextended($1,0)>>32)&4294967295) AND objid::bigint=(hashtextextended($1,0)&4294967295)) AS blocked`,
        [`entity-membership:${tenantId}`, mode],
      );
      if (result.rows[0]!.blocked) return;
    }
    throw new Error('Expected review membership waiter');
  }
  it('serializes opposing decisions and keeps ingestion behind the review transaction', async () => {
    const p = await pair();
    const value = await input(p.reviewId);
    const ready = barrier();
    const release = barrier();
    const service = app.get(CanonicalizationService);
    const original = service.canonicalizeAfterReview.bind(service);
    const spy = jest
      .spyOn(service, 'canonicalizeAfterReview')
      .mockImplementation(async (tx, args) => {
        ready.release();
        await release.promise;
        await original(tx, args);
      });
    const first = post(p.reviewId, value).then((response) => response);
    let second: Promise<request.Response> | undefined;
    let ingestion: Promise<RecordIngestionResult> | undefined;
    try {
      await ready.promise;
      second = post(p.reviewId, { ...value, decision: 'REJECT' }).then((response) => response);
      ingestion = ingest(p.data, p.external);
      await waitForGate('ShareLock');
    } finally {
      release.release();
      spy.mockRestore();
      await Promise.allSettled([first, second, ingestion]);
    }
    expect((await first).status).toBe(200);
    expect((await second)?.status).toBe(409);
    expect(await ingestion).toMatchObject({
      entity_id: p.candidate.entity_id,
      decision: 'AUTO_MATCH',
    });
    expect(await prisma.reviewDecision.count({ where: { tenantId } })).toBe(1);
  });
  it('waits for ingestion and rejects a source version that changed while reviewing', async () => {
    const p = await pair();
    const value = await input(p.reviewId);
    const ready = barrier();
    const release = barrier();
    const service = app.get(ResolutionService);
    const original = service.resolve.bind(service);
    const spy = jest.spyOn(service, 'resolve').mockImplementation(async (tx, tenant, record) => {
      ready.release();
      await release.promise;
      return original(tx, tenant, record);
    });
    const ingestion = ingest({ ...p.data, name: 'Concurrent update' }, p.external);
    let decision: Promise<request.Response> | undefined;
    try {
      await ready.promise;
      decision = post(p.reviewId, value).then((response) => response);
      await waitForGate('ExclusiveLock');
    } finally {
      release.release();
      spy.mockRestore();
    }
    await ingestion;
    expect((await decision)?.status).toBe(409);
    expect(await prisma.reviewDecision.count({ where: { tenantId } })).toBe(0);
  });
  it('enforces same-tenant audit foreign keys and append-only outcomes', async () => {
    const p = await pair();
    const response = await post(p.reviewId, await input(p.reviewId));
    expect(response.status).toBe(200);
    const result = body<ReviewDecisionResult>(response);
    await expect(
      db.query('UPDATE review_decisions SET reason=$1 WHERE id=$2', [
        'changed',
        result.review_decision_id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.query('DELETE FROM review_decisions WHERE id=$1', [result.review_decision_id]),
    ).rejects.toMatchObject({ code: '23514' });
    const other = (await prisma.tenant.create({ data: { name: 'Other' } })).id;
    const actor = await prisma.apiKey.create({
      data: { tenantId: other, name: 'Foreign', prefix: 'foreign', keyHash: randomUUID() },
    });
    const q = await pair();
    await expect(
      db.query(
        `INSERT INTO review_decisions (tenant_id,review_case_id,decision,reason,actor_api_key_id,entity_id,source_record_version,candidate_record_version,candidate_canonical_version,canonical_version)
      VALUES ($1,$2,'APPROVE','test',$3,$4,1,1,1,2)`,
        [tenantId, q.reviewId, actor.id, q.candidate.entity_id],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'review_decisions_tenant_actor_fkey' });
    expect(await prisma.reviewDecision.count({ where: { tenantId } })).toBe(1);
  });
  it.each(['APPROVE', 'REJECT'])(
    'resolves Company reviews with %s and canonical provenance',
    async (decision) => {
      const address = { city: 'Company City', country: 'ET' };
      const candidate = await ingest(
        { name: 'Acme Trading', phone: '+251911333331', address },
        randomUUID(),
        undefined,
        'company',
      );
      const incoming = await ingest(
        { name: 'Acme Trading', phone: '+251922333332', address },
        randomUUID(),
        undefined,
        'company',
      );
      expect(incoming.decision).toBe('REVIEW');
      const row = await prisma.reviewCase.findUniqueOrThrow({
        where: { tenantId_sourceRecordId: { tenantId, sourceRecordId: incoming.record_id } },
      });
      const response = await post(row.id, await input(row.id, decision));
      expect(response.status).toBe(200);
      const result = body<ReviewDecisionResult>(response);
      const entity = await prisma.entity.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: result.entity_id } },
      });
      expect(entity).toMatchObject({ entityType: 'COMPANY', status: 'ACTIVE' });
      if (decision === 'APPROVE') expect(result.entity_id).toBe(candidate.entity_id);
      else expect(result.entity_id).not.toBe(candidate.entity_id);
      expect(
        await prisma.entityFieldProvenance.count({ where: { tenantId, entityId: entity.id } }),
      ).toBeGreaterThan(0);
    },
  );
  it('handles legacy version1 evidence conservatively and prevents version overflow', async () => {
    const p = await pair();
    await prisma.reviewCase.update({
      where: { tenantId_id: { tenantId, id: p.reviewId } },
      data: { sourceRecordVersion: null, candidateRecordVersion: null },
    });
    expect(body<ReviewDetailDto>(await get(`/${p.reviewId}`)).approval_available).toBe(true);
    expect((await post(p.reviewId, await input(p.reviewId))).status).toBe(200);
    const q = await pair();
    await prisma.reviewCase.update({
      where: { tenantId_id: { tenantId, id: q.reviewId } },
      data: { sourceRecordVersion: null, candidateRecordVersion: null },
    });
    await ingest({ ...q.data, name: 'Updated legacy source' }, q.external);
    await denied(q.reviewId, await input(q.reviewId), 'REVIEW_EVIDENCE_STALE');
    const r = await pair();
    await prisma.entity.update({
      where: { tenantId_id: { tenantId, id: r.candidate.entity_id } },
      data: { canonicalVersion: 2147483647 },
    });
    await denied(r.reviewId, await input(r.reviewId), 'ENTITY_VERSION_CONFLICT');
  });
  it('exposes review scope, validation, response, and nullable audit metadata in OpenAPI', async () => {
    const response = await request(server).get('/docs-json');
    expect(response.status).toBe(200);
    const document = body<{
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    }>(response);
    expect(document.paths).toHaveProperty('/v1/reviews');
    expect(document.paths).toHaveProperty('/v1/reviews/{reviewId}');
    expect(document.paths['/v1/reviews/{reviewId}/decision']).toMatchObject({
      post: {
        responses: {
          '200': { description: '' },
          '400': { description: '' },
          '401': { description: '' },
          '403': { description: '' },
          '409': { description: '' },
        },
      },
    });
    expect(document.components.schemas.ReviewDecisionResponseDto).toMatchObject({
      properties: {
        review_decision_id: { format: 'uuid' },
        decision: { enum: ['APPROVE', 'REJECT'] },
      },
    });
    expect(document.components.schemas.EntityHistoryTriggerDto).toMatchObject({
      properties: { review_decision_id: { nullable: true } },
    });
  });
});
