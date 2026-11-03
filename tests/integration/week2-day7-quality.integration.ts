import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import {
  EntityType,
  MATCHING_POLICY,
  ResolutionDecision,
  type RecordIngestionResult,
} from '@resolve/contracts';
import { createPrismaClient, type ResolvePrismaClient } from '@resolve/database';
import { extractFeatures, FEATURE_VERSION, scoreFeatures } from '@resolve/matching';
import { NORMALIZATION_VERSION, normalizeRecord } from '@resolve/normalization';
import { Client } from 'pg';
import request from 'supertest';
import type { ResolveApplication } from '../../apps/api/src/application.js';
import { hashApiKey } from '../../apps/api/src/auth/api-key.js';
import { BLOCKING_VERSION } from '../../apps/api/src/blocking/blocking-policy.js';
import { measureQuality } from '../golden-dataset/quality-metrics.js';

interface GoldenCase {
  id: string;
  entity_type: 'person' | 'company';
  record_a: Record<string, unknown>;
  record_b: Record<string, unknown>;
  expected_decision: ResolutionDecision;
}

interface QualityLabel {
  id: string;
  same_identity: boolean;
  identity_rationale: string;
  expected_pipeline_decision: ResolutionDecision;
  expected_candidate_count: number;
}

describe('Week 2 Day 7 end-to-end golden quality', () => {
  const schema = `resolve_day7_quality_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const base = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  base.searchParams.delete('schema');
  const db = new Client({ connectionString: base.toString(), connectionTimeoutMillis: 5000 });
  const saved = { ...process.env };
  const reportDirectory = resolve('.superpowers/sdd/week2-day7-quality');
  const reportPath = resolve(reportDirectory, 'golden-report.json');
  let ownsSchema = false;
  let connected = false;
  let prisma: ResolvePrismaClient | undefined;
  let app: ResolveApplication | undefined;
  let server: Server;

  beforeAll(async () => {
    await mkdir(reportDirectory, { recursive: true });
    // A failed run must never leave a previous successful report looking current.
    await rm(reportPath, { force: true });
    await db.connect();
    connected = true;
    await db.query(`CREATE SCHEMA "${schema}"`);
    ownsSchema = true;
    await db.query(`SET search_path TO "${schema}"`);
    const root = resolve('packages/database/prisma/migrations');
    for (const directory of (await readdir(root)).filter((name) => /^\d/.test(name)).sort()) {
      await db.query(await readFile(resolve(root, directory, 'migration.sql'), 'utf8'));
    }
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
      BLOCKING_MAX_CANDIDATES: '100',
    });
    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        await prisma?.$disconnect();
      } finally {
        try {
          if (ownsSchema) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          if (connected) await db.end();
          for (const name of Object.keys(process.env)) {
            if (!(name in saved)) delete process.env[name];
          }
          Object.assign(process.env, saved);
        }
      }
    }
  });

  it('measures real API decisions and records blocking misses without changing policy', async () => {
    const datasetText = await readFile(resolve('tests/golden-dataset/mvp-v1.json'), 'utf8');
    const labelsText = await readFile(resolve('tests/golden-dataset/quality-v1.json'), 'utf8');
    const dataset = JSON.parse(datasetText) as { version: string; cases: GoldenCase[] };
    const labels = JSON.parse(labelsText) as {
      version: string;
      dataset_version: string;
      label_origin: string;
      cases: QualityLabel[];
    };
    expect(labels.dataset_version).toBe(dataset.version);
    expect(labels.cases).toHaveLength(dataset.cases.length);
    expect(new Set(labels.cases.map((item) => item.id))).toEqual(
      new Set(dataset.cases.map((item) => item.id)),
    );
    const results = [];
    const regressions: string[] = [];
    for (const fixture of dataset.cases) {
      const label = labels.cases.find((item) => item.id === fixture.id)!;
      const tenantId = (await prisma!.tenant.create({ data: { name: fixture.id } })).id;
      const token = `rslv_test_${randomUUID().replaceAll('-', '').slice(0, 12)}.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789`;
      await prisma!.apiKey.create({
        data: {
          tenantId,
          name: 'Synthetic golden evaluator',
          prefix: token.split('.')[0]!,
          keyHash: hashApiKey(token),
          scopes: ['sources:write', 'records:write', 'entities:read'],
        },
      });
      for (const name of ['crm', 'billing']) {
        await request(server)
          .post('/v1/sources')
          .auth(token, { type: 'bearer' })
          .send({ name, type: 'api' })
          .expect(201);
      }
      const first = await ingest('crm', fixture.record_a);
      expect(first.decision).toBe('NO_MATCH');
      expect(first.explanation.candidate_count).toBe(0);
      const incoming = await ingest('billing', fixture.record_b, `${fixture.id}-b`);
      if (incoming.decision !== label.expected_pipeline_decision) {
        regressions.push(
          `${fixture.id}: expected ${label.expected_pipeline_decision}, got ${incoming.decision}`,
        );
      }
      if (incoming.explanation.candidate_count !== label.expected_candidate_count) {
        regressions.push(
          `${fixture.id}: candidate count changed from ${label.expected_candidate_count} to ${incoming.explanation.candidate_count}`,
        );
      }
      expect(incoming.algorithm_version).toBe(MATCHING_POLICY.version);
      expect(incoming.confidence).toBeGreaterThanOrEqual(0);
      expect(incoming.confidence).toBeLessThanOrEqual(1);

      const raw = await prisma!.sourceRecord.findMany({ where: { tenantId } });
      expect(raw).toHaveLength(2);
      for (const [result, payload] of [
        [first, fixture.record_a],
        [incoming, fixture.record_b],
      ] as const) {
        const stored = raw.find((item) => item.id === result.record_id)!;
        expect(stored.rawPayload).toEqual(payload);
        expect(stored.normalizationVersion).toBe(NORMALIZATION_VERSION);
        expect(stored.normalizedPayload).toEqual(
          normalizeRecord(fixture.entity_type, payload).normalized_payload,
        );
      }
      const links = await prisma!.entityRecordLink.findMany({ where: { tenantId } });
      const reviews = await prisma!.reviewCase.findMany({ where: { tenantId } });
      const evidence = await prisma!.matchFeature.findMany({
        where: { tenantId, sourceRecordId: incoming.record_id },
      });
      expect(evidence).toHaveLength(incoming.explanation.candidate_count);
      for (const comparison of evidence) {
        expect(comparison).toMatchObject({
          candidateEntityId: first.entity_id,
          candidateSourceRecordId: first.record_id,
          featureVersion: FEATURE_VERSION,
          algorithmVersion: MATCHING_POLICY.version,
        });
        expect(comparison.scoreInputs).toHaveProperty('features');
        expect(comparison.explanation).toHaveProperty('thresholds', MATCHING_POLICY.thresholds);
      }
      if (incoming.decision === ResolutionDecision.Review) {
        expect(links).toHaveLength(1);
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toMatchObject({ status: 'OPEN', sourceRecordId: incoming.record_id });
      } else {
        expect(links).toHaveLength(2);
        expect(reviews).toHaveLength(0);
        expect(incoming.entity_id === first.entity_id).toBe(
          incoming.decision === ResolutionDecision.AutoMatch,
        );
        const entity = await request(server)
          .get(`/v1/entities/${incoming.entity_id}`)
          .auth(token, { type: 'bearer' })
          .expect(200);
        expect(entity.body).toHaveProperty('canonical_version');
      }
      const replay = await ingest('billing', fixture.record_b, `${fixture.id}-b`, 200);
      expect(replay).toMatchObject({
        record_id: incoming.record_id,
        decision: incoming.decision,
        entity_id: incoming.entity_id,
        confidence: incoming.confidence,
        explanation: incoming.explanation,
        operation: 'UNCHANGED',
      });
      expect(await prisma!.sourceRecordVersion.count({ where: { tenantId } })).toBe(2);
      expect(await prisma!.matchFeature.count({ where: { tenantId } })).toBe(evidence.length);
      expect(await prisma!.reviewCase.count({ where: { tenantId } })).toBe(reviews.length);

      const entityType = fixture.entity_type === 'person' ? EntityType.Person : EntityType.Company;
      const scorer = scoreFeatures(
        extractFeatures(
          {
            entityType,
            rawPayload: fixture.record_b,
            normalizedPayload: normalizeRecord(fixture.entity_type, fixture.record_b)
              .normalized_payload,
          },
          {
            entityType,
            rawPayload: fixture.record_a,
            normalizedPayload: normalizeRecord(fixture.entity_type, fixture.record_a)
              .normalized_payload,
          },
        ),
      );
      if (scorer.decision !== fixture.expected_decision) {
        regressions.push(
          `${fixture.id}: pairwise decision changed from ${fixture.expected_decision} to ${scorer.decision}`,
        );
      }
      results.push({
        id: fixture.id,
        entity_type: fixture.entity_type,
        same_identity: label.same_identity,
        identity_rationale: label.identity_rationale,
        decision: incoming.decision,
        confidence: incoming.confidence,
        candidate_count: incoming.explanation.candidate_count,
        expected_pipeline_decision: label.expected_pipeline_decision,
        expected_candidate_count: label.expected_candidate_count,
        pairwise_decision: scorer.decision,
        expected_pairwise_decision: fixture.expected_decision,
        pairwise_confidence: scorer.score,
        positive_blocking_miss: label.same_identity && incoming.explanation.candidate_count === 0,
        contradictions: incoming.explanation.contradictions,
      });

      async function ingest(
        source: string,
        data: Record<string, unknown>,
        externalId = `${fixture.id}-a`,
        status = 201,
      ): Promise<RecordIngestionResult> {
        const response = await request(server)
          .post('/v1/records')
          .auth(token, { type: 'bearer' })
          .send({ source, external_id: externalId, entity_type: fixture.entity_type, data })
          .expect(status);
        return response.body as RecordIngestionResult;
      }
    }
    const metrics = measureQuality(results);
    const report = {
      dataset_version: dataset.version,
      labels_version: labels.version,
      dataset_sha256: createHash('sha256').update(datasetText).digest('hex'),
      labels_sha256: createHash('sha256').update(labelsText).digest('hex'),
      label_origin: labels.label_origin,
      evaluation_unit:
        'Record B after seeding record A in a fresh tenant per pair; seeds and replays excluded.',
      scope:
        'Eight authored synthetic pairs; not an estimate of production quality. REVIEW is an abstention; no human outcomes included.',
      versions: {
        normalization: NORMALIZATION_VERSION,
        blocking: BLOCKING_VERSION,
        features: FEATURE_VERSION,
        scorer: MATCHING_POLICY.version,
      },
      policy: MATCHING_POLICY,
      metrics,
      regressions,
      cases: results,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.info(`Golden quality report: ${reportPath}\n${JSON.stringify(metrics, null, 2)}`);
    expect(regressions).toEqual([]);
    expect(metrics.false_positives).toBe(0);
    expect(metrics.evaluated_pairs).toBe(8);
  });
});
