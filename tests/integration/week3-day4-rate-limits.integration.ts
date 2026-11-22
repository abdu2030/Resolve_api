import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { jest } from '@jest/globals';
import { createPrismaClient, type ResolvePrismaClient } from '@resolve/database';
import type { Redis } from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';

import type { ResolveApplication } from '../../apps/api/src/application.js';
import { generateApiKey } from '../../apps/api/src/auth/api-key.js';
import { REDIS_CLIENT } from '../../apps/api/src/infrastructure/infrastructure.tokens.js';

describe('Week 3 distributed API rate limits', () => {
  const schema = 'resolve_limits_' + randomUUID().replaceAll('-', '');
  const queuePrefix = schema;
  const saved = { ...process.env };
  const url = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  url.searchParams.delete('schema');
  const database = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  let ownsSchema = false;
  let prisma: ResolvePrismaClient;
  let app: ResolveApplication;
  let redis: Redis;
  let server: Server;

  beforeAll(async () => {
    await database.connect();
    await database.query('CREATE SCHEMA "' + schema + '"');
    ownsSchema = true;
    await database.query('SET search_path TO "' + schema + '"');
    const root = resolve('packages/database/prisma/migrations');
    for (const directory of (await readdir(root)).filter((name) => /^\d/.test(name)).sort()) {
      await database.query(await readFile(resolve(root, directory, 'migration.sql'), 'utf8'));
    }
    url.searchParams.set('schema', schema);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      API_PORT: '3000',
      REQUEST_BODY_LIMIT: '1mb',
      DATABASE_URL: url.toString(),
      BATCH_QUEUE_PREFIX: queuePrefix,
      REDIS_HOST: process.env.TEST_REDIS_HOST ?? 'localhost',
      REDIS_PORT: process.env.TEST_REDIS_PORT ?? '6379',
      RATE_LIMIT_WINDOW_SECONDS: '60',
      RATE_LIMIT_KEY_MAX: '3',
      RATE_LIMIT_TENANT_MAX: '5',
      RATE_LIMIT_BATCH_KEY_MAX: '1',
      RATE_LIMIT_BATCH_TENANT_MAX: '2',
    });
    prisma = createPrismaClient(url.toString());
    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    redis = app.get<Redis>(REDIS_CLIENT);
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    try {
      if (redis?.status === 'ready') {
        const keys = await redis.keys(queuePrefix + ':rate-limit:*');
        if (keys.length > 0) await redis.del(...keys);
      }
    } finally {
      await app?.close();
      await prisma?.$disconnect();
      if (ownsSchema) await database.query('DROP SCHEMA "' + schema + '" CASCADE');
      await database.end();
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });

  async function makeTenant(): Promise<string> {
    const tenant = await prisma.tenant.create({ data: { name: 'Rate-limit fixture' } });
    return tenant.id;
  }

  async function makeKey(tenantId: string, scopes: string[]): Promise<string> {
    const key = generateApiKey('test');
    await prisma.apiKey.create({
      data: { tenantId, scopes, name: 'Rate-limit fixture', prefix: key.prefix, keyHash: key.hash },
    });
    return key.plaintext;
  }

  function readJob(token: string): request.Test {
    return request(server)
      .get('/v1/jobs/' + randomUUID())
      .auth(token, { type: 'bearer' });
  }

  it('starts the Redis connection and disables resending quota mutations', () => {
    expect(redis.status).toBe('ready');
    expect(redis.options).toMatchObject({
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
    });
  });

  it('adheres to both budgets under contention and isolates tenants', async () => {
    const tenantId = await makeTenant();
    const first = await makeKey(tenantId, ['jobs:read']);
    const second = await makeKey(tenantId, ['jobs:read']);
    const outsider = await makeKey(await makeTenant(), ['jobs:read']);
    const competing = await Promise.all(Array.from({ length: 5 }, () => readJob(first)));
    expect(competing.map((response) => response.status).sort()).toEqual([404, 404, 404, 429, 429]);
    const denied = competing.find((response) => response.status === 429)!;
    expect(denied.body).toEqual({
      error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Request rate limit exceeded' },
    });
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(denied.headers['retry-after'])).toBeLessThanOrEqual(60);
    await readJob(second).expect(404);
    await readJob(second).expect(404);
    await readJob(second).expect(429);
    const tenantBudgets = await redis.keys(queuePrefix + ':rate-limit:{' + tenantId + '}:*');
    expect(tenantBudgets).toHaveLength(3);
    const lifetimes = await Promise.all(tenantBudgets.map((key) => redis.pttl(key)));
    for (const remainingMs of lifetimes) {
      expect(remainingMs).toBeGreaterThan(0);
      expect(remainingMs).toBeLessThanOrEqual(60_000);
    }
    await readJob(outsider).expect(404);
    await request(server).get('/health').expect(200);
  });

  it('enforces separate batch budgets while preserving room for ordinary requests', async () => {
    const tenantId = await makeTenant();
    await prisma.sourceSystem.create({ data: { tenantId, name: 'crm', type: 'api' } });
    const first = await makeKey(tenantId, ['jobs:read', 'records:write']);
    const second = await makeKey(tenantId, ['jobs:read', 'records:write']);
    const third = await makeKey(tenantId, ['jobs:read', 'records:write']);
    const submit = (token: string): request.Test =>
      request(server)
        .post('/v1/records/batch')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({
          records: [
            {
              source: 'crm',
              external_id: 'fixture',
              entity_type: 'person',
              data: { name: 'Batch rate fixture' },
            },
          ],
        });
    await submit(first).expect(202);
    await submit(first).expect(429);
    await readJob(first).expect(404);
    await readJob(first).expect(404);
    await submit(second).expect(202);
    await submit(third).expect(429);
    await readJob(third).expect(404);
    expect(await prisma.job.count({ where: { tenantId } })).toBe(2);
  });

  it('documents Retry-After on protected operations and leaves public probes exempt', async () => {
    const document = (await request(server).get('/docs-json').expect(200)).body as {
      paths: object;
    };
    expect(document.paths).toHaveProperty(
      ['/v1/records/batch', 'post', 'responses', '429', 'headers', 'Retry-After'],
      expect.objectContaining({ schema: { type: 'integer', minimum: 1 } }),
    );
    expect(document.paths).toHaveProperty(['/v1/records/batch', 'post', 'responses', '503']);
    expect(document.paths).not.toHaveProperty(['/health/ready', 'get', 'responses', '429']);
  });

  it('preserves the auth error contract and fails closed when Redis cannot check a budget', async () => {
    const token = await makeKey(await makeTenant(), ['jobs:read']);
    const insufficient = await makeKey(await makeTenant(), ['records:write']);
    const unavailable = jest
      .spyOn(redis, 'eval')
      .mockRejectedValueOnce(new Error('private Redis detail'));
    try {
      await readJob('invalid-key').expect(401);
      await readJob(insufficient).expect(403);
      expect(unavailable).not.toHaveBeenCalled();
      const response = await readJob(token).expect(503);
      expect(response.body).toEqual({
        error: {
          code: 'RATE_LIMIT_UNAVAILABLE',
          message: 'Request rate limit is temporarily unavailable',
        },
      });
      expect(response.text).not.toContain('private Redis detail');
    } finally {
      unavailable.mockRestore();
    }
  });
});
