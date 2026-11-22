import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { EntityType, type RecordIngestionResult, type RecordInputDto } from '@resolve/contracts';
import { createPrismaClient, type ResolvePrismaClient } from '@resolve/database';
import { Redis } from 'ioredis';
import { Client } from 'pg';

import type { ResolveApplication } from '../../apps/api/src/application.js';
import { generateApiKey } from '../../apps/api/src/auth/api-key.js';
import type { AcceptedBatchDto, BatchJobDto } from '../../apps/api/src/jobs/batch-job.dto.js';
import type { createWorker } from '../../apps/worker/src/worker.js';

const describeLoad = process.env.RUN_RESOLVE_LOAD === '1' ? describe : describe.skip;
const directPairs = 40;
const directConcurrency = 4;
const batchCount = 6;
const pairsPerBatch = 50;
const pollMs = 250;
const batchDeadlineMs = 180_000;
const sampleMs = 25;
const slowMs = 25;

interface TimingSummary {
  count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
}

interface SlowObservation {
  statement_kind: string | null;
  wait_kind: string | null;
  elapsed_ms: number;
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

function summarize(timings: number[]): TimingSummary {
  const sorted = [...timings].sort((a, b) => a - b);
  const at = (quantile: number): number =>
    rounded(sorted[Math.ceil(quantile * sorted.length) - 1]!);
  return {
    count: sorted.length,
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    p99_ms: at(0.99),
    max_ms: at(1),
  };
}

function fixture(
  group: string,
  person: number,
  source: 'crm' | 'billing',
): Pick<RecordInputDto, 'source' | 'external_id' | 'entity_type'> & {
  data: { name: string; email: string };
} {
  return {
    source,
    external_id: group + '-' + person,
    entity_type: EntityType.Person,
    data: {
      name: 'Synthetic Person ' + group + ' ' + person,
      email: group + '-' + person + '@load.example.test',
    },
  };
}

describeLoad('Day 5 synthetic HTTP and batch load', () => {
  const schema = 'resolve_load_' + randomUUID().replaceAll('-', '');
  const saved = { ...process.env };
  const connectionUrl = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  connectionUrl.searchParams.delete('schema');
  const admin = new Client({
    connectionString: connectionUrl.toString(),
    connectionTimeoutMillis: 5000,
  });
  let app: ResolveApplication | undefined;
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let prisma: ResolvePrismaClient | undefined;
  let ownsSchema = false;
  let baseUrl: string;
  let tenantId: string;
  let apiKey: string;

  beforeAll(async () => {
    await admin.connect();
    await admin.query('CREATE SCHEMA "' + schema + '"');
    ownsSchema = true;
    await admin.query('SET search_path TO "' + schema + '"');
    const migrations = resolve('packages/database/prisma/migrations');
    for (const directory of (await readdir(migrations)).filter((name) => /^\d/.test(name)).sort()) {
      await admin.query(await readFile(resolve(migrations, directory, 'migration.sql'), 'utf8'));
    }

    connectionUrl.searchParams.set('schema', schema);
    connectionUrl.searchParams.set('application_name', schema);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      API_PORT: '3000',
      REQUEST_BODY_LIMIT: '1mb',
      DATABASE_URL: connectionUrl.toString(),
      BATCH_QUEUE_PREFIX: schema,
      BLOCKING_MAX_CANDIDATES: '100',
      REDIS_HOST: process.env.TEST_REDIS_HOST ?? 'localhost',
      REDIS_PORT: process.env.TEST_REDIS_PORT ?? '6379',
      RATE_LIMIT_KEY_MAX: '10000',
      RATE_LIMIT_TENANT_MAX: '10000',
      RATE_LIMIT_BATCH_KEY_MAX: '20',
      RATE_LIMIT_BATCH_TENANT_MAX: '100',
      RATE_LIMIT_WINDOW_SECONDS: '60',
      WEBHOOK_ENCRYPTION_KEY: '',
    });
    prisma = createPrismaClient(connectionUrl.toString());
    tenantId = (await prisma.tenant.create({ data: { name: 'Synthetic load tenant' } })).id;
    await prisma.sourceSystem.createMany({
      data: ['crm', 'billing'].map((name) => ({ tenantId, name, type: 'api' })),
    });
    const key = generateApiKey('test');
    apiKey = key.plaintext;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: 'Load fixture',
        prefix: key.prefix,
        keyHash: key.hash,
        scopes: ['records:write', 'jobs:read'],
      },
    });

    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    const { createWorker } = await import('../../apps/worker/src/worker.js');
    worker = await createWorker();
    worker.useLogger(false);
  });

  afterAll(async () => {
    try {
      try {
        await worker?.close();
        await app?.close();
      } finally {
        await prisma?.$disconnect();
      }
      if (ownsSchema && app) {
        const redis = new Redis({
          host: process.env.REDIS_HOST!,
          port: Number(process.env.REDIS_PORT!),
          maxRetriesPerRequest: 1,
        });
        try {
          const keys = await redis.keys(schema + ':*');
          if (keys.length > 0) await redis.del(...keys);
        } finally {
          redis.disconnect();
        }
      }
    } finally {
      try {
        if (ownsSchema) await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
      } finally {
        await admin.end();
        for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
        Object.assign(process.env, saved);
      }
    }
  });

  async function send<T>(
    path: string,
    expectedStatus: number,
    body?: object,
    key?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: 'Bearer ' + apiKey };
    if (key) headers['Idempotency-Key'] = key;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(baseUrl + path, {
      headers,
      method: body ? 'POST' : 'GET',
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(expectedStatus);
    return (await response.json()) as T;
  }

  async function runDirect(): Promise<number[]> {
    for (const source of ['crm', 'billing'] as const) {
      await send('/v1/records', 201, fixture('warmup', 0, source));
    }
    const timings: number[] = [];
    for (let first = 0; first < directPairs; first += directConcurrency) {
      await Promise.all(
        Array.from({ length: directConcurrency }, async (_, offset) => {
          const person = first + offset;
          const started = performance.now();
          const primary = await send<RecordIngestionResult>(
            '/v1/records',
            201,
            fixture('direct', person, 'crm'),
          );
          const primaryDone = performance.now();
          const duplicate = await send<RecordIngestionResult>(
            '/v1/records',
            201,
            fixture('direct', person, 'billing'),
          );
          timings.push(primaryDone - started, performance.now() - primaryDone);
          expect(primary.decision).toBe('NO_MATCH');
          expect(duplicate).toMatchObject({ entity_id: primary.entity_id, decision: 'AUTO_MATCH' });
        }),
      );
    }
    return timings;
  }

  async function runBatch(index: number): Promise<{ acceptMs: number; completeMs: number }> {
    const group = 'batch-' + index;
    const records = Array.from({ length: pairsPerBatch }, (_, person) => [
      fixture(group, person, 'crm'),
      fixture(group, person, 'billing'),
    ]).flat();
    const started = performance.now();
    const job = await send<AcceptedBatchDto>('/v1/records/batch', 202, { records }, group);
    const acceptMs = performance.now() - started;
    while (performance.now() - started < batchDeadlineMs) {
      const result = await send<BatchJobDto>('/v1/jobs/' + job.job_id, 200);
      if (result.status === 'SUCCEEDED' || result.status === 'FAILED') {
        const completeMs = performance.now() - started;
        expect(result).toMatchObject({
          status: 'SUCCEEDED',
          attempts: 1,
          processed_records: records.length,
          succeeded_records: records.length,
          failed_records: 0,
        });
        for (let item = 0; item < records.length; item += 2) {
          const first = result.results[item];
          const second = result.results[item + 1];
          expect(first).toMatchObject({
            index: item,
            error: null,
            result: { decision: 'NO_MATCH' },
          });
          expect(second).toMatchObject({
            index: item + 1,
            error: null,
            result: { decision: 'AUTO_MATCH', entity_id: first?.result?.entity_id },
          });
        }
        return { acceptMs, completeMs };
      }
      await delay(pollMs);
    }
    throw new Error('Synthetic batch did not finish before the benchmark deadline');
  }

  async function sampleSlowQueries(stop: AbortSignal): Promise<SlowObservation[]> {
    const observations: SlowObservation[] = [];
    while (!stop.aborted) {
      // Inspect only the SQL verb, duration and wait category for this run's own connections.
      const result = await admin.query<SlowObservation>(
        `SELECT upper(substring(ltrim(query) from '^[a-zA-Z]+')) AS statement_kind,
                wait_event_type AS wait_kind,
                extract(epoch from clock_timestamp() - query_start)::float8 * 1000 AS elapsed_ms
         FROM pg_stat_activity
         WHERE application_name = $1 AND state = 'active'
           AND clock_timestamp() - query_start >= $2::int * interval '1 millisecond'`,
        [schema, slowMs],
      );
      observations.push(...result.rows);
      await delay(sampleMs, undefined, { signal: stop }).catch((error: unknown) => {
        if (!stop.aborted) throw error;
      });
    }
    return observations;
  }

  it(
    'runs duplicate resolution through the live HTTP API and BullMQ worker',
    async () => {
      const sampler = new AbortController();
      const sampled = sampleSlowQueries(sampler.signal);
      try {
        const directLatencies = await runDirect();
        const started = performance.now();
        const jobs = await Promise.all(
          Array.from({ length: batchCount }, (_, index) => runBatch(index)),
        );
        const batchWallMs = performance.now() - started;
        const batchRecords = batchCount * pairsPerBatch * 2;
        expect(await prisma!.entity.count({ where: { tenantId } })).toBe(
          1 + directPairs + batchCount * pairsPerBatch,
        );
        expect(await prisma!.sourceRecord.count({ where: { tenantId } })).toBe(
          2 + directPairs * 2 + batchRecords,
        );

        sampler.abort();
        const slow = await sampled;
        const kinds = new Map<string, number>();
        let longestActiveMs = 0;
        for (const row of slow) {
          longestActiveMs = Math.max(longestActiveMs, row.elapsed_ms);
          const kind = [row.statement_kind ?? 'UNKNOWN', row.wait_kind ?? 'no reported wait'].join(
            '/',
          );
          kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        }
        console.info(
          'Resolve load baseline ' +
            JSON.stringify({
              direct: { concurrency: directConcurrency, ...summarize(directLatencies) },
              batch: {
                jobs: batchCount,
                records: batchRecords,
                wall_ms: rounded(batchWallMs),
                records_per_second: rounded((batchRecords * 1000) / batchWallMs),
                poll_interval_ms: pollMs,
                acceptance_ms: jobs.map((job) => rounded(job.acceptMs)),
                completion_ms: jobs.map((job) => rounded(job.completeMs)),
              },
              slow_samples: {
                threshold_ms: slowMs,
                interval_ms: sampleMs,
                observations_by_kind: Object.fromEntries(kinds),
                longest_active_ms: rounded(longestActiveMs),
              },
            }),
        );
      } finally {
        sampler.abort();
        await sampled;
      }
    },
    batchDeadlineMs + 60_000,
  );
});
