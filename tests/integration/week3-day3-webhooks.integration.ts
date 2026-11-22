import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { jest } from '@jest/globals';
import { createPrismaClient, type ResolvePrismaClient } from '@resolve/database';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import type { ResolveApplication } from '../../apps/api/src/application.js';
import { generateApiKey } from '../../apps/api/src/auth/api-key.js';
import type { AcceptedBatchDto } from '../../apps/api/src/jobs/batch-job.dto.js';
import { WebhookTransport } from '../../apps/api/src/webhooks/webhook-transport.js';
import { prepareWebhookDestination } from '../../apps/api/src/webhooks/webhook-destination.js';
import type {
  WebhookDeliveryDetailDto,
  WebhookEndpointDto,
} from '../../apps/api/src/webhooks/webhook.dto.js';
import type { createWorker } from '../../apps/worker/src/worker.js';

describe('Week 3 webhook HTTP and worker', () => {
  const schema = 'resolve_hooks_' + randomUUID().replaceAll('-', '');
  const url = new URL(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://resolve:resolve@localhost:5432/resolve',
  );
  url.searchParams.delete('schema');
  const db = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const saved = { ...process.env };
  const signingSecret = 'af'.repeat(32);
  const basePath = '/v1/webhook-endpoints';
  let ownsSchema = false;
  let app: ResolveApplication | undefined;
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let prisma: ResolvePrismaClient;
  let server: Server;
  let tenantId: string;
  let owner: string;
  let outsider: string;
  let restricted: string;

  beforeAll(async () => {
    await db.connect();
    await db.query('CREATE SCHEMA "' + schema + '"');
    ownsSchema = true;
    await db.query('SET search_path TO "' + schema + '"');
    const root = resolve('packages/database/prisma/migrations');
    for (const directory of (await readdir(root)).filter((name) => /^\d/.test(name)).sort()) {
      await db.query(await readFile(resolve(root, directory, 'migration.sql'), 'utf8'));
    }
    url.searchParams.set('schema', schema);
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      NODE_ENV: 'test',
      API_PORT: '3000',
      REDIS_HOST: process.env.TEST_REDIS_HOST ?? 'localhost',
      REDIS_PORT: process.env.TEST_REDIS_PORT ?? '6379',
      BATCH_QUEUE_PREFIX: schema,
      REQUEST_BODY_LIMIT: '1mb',
      WEBHOOK_ENCRYPTION_KEY: 'ab'.repeat(32),
      WEBHOOK_MAX_ATTEMPTS: '3',
      WEBHOOK_RETRY_BASE_MS: '100',
    });
    prisma = createPrismaClient(url.toString());
    tenantId = (await prisma.tenant.create({ data: { name: 'Webhook owner' } })).id;
    const foreign = (await prisma.tenant.create({ data: { name: 'Webhook outsider' } })).id;
    await prisma.sourceSystem.create({ data: { tenantId, name: 'crm', type: 'api' } });
    owner = await makeKey(tenantId, ['records:write', 'jobs:read', 'webhooks:manage']);
    outsider = await makeKey(foreign, ['webhooks:manage']);
    restricted = await makeKey(tenantId, ['records:write']);
    jest.spyOn(WebhookTransport.prototype, 'resolve').mockImplementation(async (destination) => {
      if (new URL(destination).hostname === 'localhost') {
        return prepareWebhookDestination(destination);
      }
      return { url: new URL(destination), addresses: [{ address: '93.184.215.14', family: 4 }] };
    });
    const { createApplication } = await import('../../apps/api/src/application.js');
    app = await createApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    try {
      await worker?.close();
      await app?.close();
      await prisma?.$disconnect();
      if (ownsSchema) {
        const redis = new Redis({
          host: process.env.REDIS_HOST!,
          port: Number(process.env.REDIS_PORT!),
          maxRetriesPerRequest: 1,
        });
        try {
          const keys = await redis.keys(schema + ':*');
          if (keys.length) await redis.del(...keys);
        } finally {
          redis.disconnect();
        }
        await db.query('DROP SCHEMA "' + schema + '" CASCADE');
      }
    } finally {
      await db.end();
      jest.restoreAllMocks();
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });

  async function makeKey(tenantId: string, scopes: string[]): Promise<string> {
    const key = generateApiKey('test');
    await prisma.apiKey.create({
      data: {
        tenantId,
        scopes,
        name: 'Webhook test',
        prefix: key.prefix,
        keyHash: key.hash,
      },
    });
    return key.plaintext;
  }

  it('enforces scope, public HTTPS registration, and duplicate endpoint protection', async () => {
    const body = {
      url: 'https://callbacks.example.test/events',
      events: ['record.resolved'],
      signing_secret: signingSecret,
    };
    await request(server)
      .post(basePath)
      .auth(restricted, { type: 'bearer' })
      .send(body)
      .expect(403);
    await request(server)
      .post(basePath)
      .auth(owner, { type: 'bearer' })
      .send({ ...body, url: 'https://localhost/events' })
      .expect(422);
    const registered = await request(server)
      .post(basePath)
      .auth(owner, { type: 'bearer' })
      .send(body)
      .expect(201);
    expect(registered.text).not.toContain(signingSecret);
    const endpointId = (registered.body as WebhookEndpointDto).endpoint_id;
    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } });
    expect(row.encryptedSecret).not.toContain(signingSecret);
    await request(server).post(basePath).auth(owner, { type: 'bearer' }).send(body).expect(409);
    await request(server)
      .get(basePath + '/' + endpointId + '/deliveries')
      .auth(outsider, { type: 'bearer' })
      .expect(404);
  });

  it('delivers a stable event, preserves interrupted and failed attempts, and replays idempotently', async () => {
    const registered = await request(server)
      .post(basePath)
      .auth(owner, { type: 'bearer' })
      .send({
        url: 'https://retry.example.test/events',
        events: ['record.resolved'],
        signing_secret: signingSecret,
      })
      .expect(201);
    const foreign = await request(server)
      .post(basePath)
      .auth(outsider, { type: 'bearer' })
      .send({
        url: 'https://foreign.example.test/events',
        events: ['record.resolved'],
        signing_secret: signingSecret,
      })
      .expect(201);
    const endpointId = (registered.body as WebhookEndpointDto).endpoint_id;
    const record = {
      source: 'crm',
      external_id: 'one',
      entity_type: 'person',
      data: { name: 'Webhook Fixture', email: 'fixture@example.test' },
    };
    const ingest = (): request.Test =>
      request(server)
        .post('/v1/records')
        .auth(owner, { type: 'bearer' })
        .set('Idempotency-Key', 'webhook-record')
        .send(record);
    await ingest().expect(201);
    await ingest().expect(201).expect('Idempotency-Replayed', 'true');
    await request(server)
      .post('/v1/records')
      .auth(owner, { type: 'bearer' })
      .send(record)
      .expect(200);
    const rows = await prisma.webhookEvent.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    const eventId = rows[0]!.id;
    expect(
      await prisma.webhookDelivery.count({
        where: { endpointId: (foreign.body as WebhookEndpointDto).endpoint_id },
      }),
    ).toBe(0);
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { tenantId, endpointId, eventId },
    });
    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'RUNNING',
          attempts: 1,
          availableAt: new Date(0),
        },
      }),
      prisma.webhookAttempt.create({ data: { tenantId, deliveryId: delivery.id, number: 1 } }),
    ]);
    const sent: { event: Record<string, unknown>; signatureKey: string; body: string }[] = [];
    jest.spyOn(WebhookTransport.prototype, 'send').mockImplementation((target, body, secret) => {
      if (new URL(target).hostname !== 'retry.example.test') return Promise.resolve(204);
      sent.push({
        event: JSON.parse(body.toString()) as Record<string, unknown>,
        signatureKey: secret.toString('hex'),
        body: body.toString(),
      });
      return Promise.resolve(sent.length === 1 ? 503 : sent.length === 2 ? 400 : 204);
    });
    const { createWorker } = await import('../../apps/worker/src/worker.js');
    worker = await createWorker();
    const detail = basePath + '/' + endpointId + '/deliveries/' + eventId;
    const read = (): request.Test =>
      request(server).get(detail).auth(owner, { type: 'bearer' }).expect(200);
    async function waitFor(status: string): Promise<WebhookDeliveryDetailDto> {
      for (let index = 0; index < 200; index++) {
        const result = (await read()).body as WebhookDeliveryDetailDto;
        if (result.status === status) return result;
        await delay(100);
      }
      throw new Error('Webhook delivery did not reach ' + status);
    }
    const dead = await waitFor('DEAD_LETTER');
    expect(dead.attempt_history).toEqual([
      expect.objectContaining({ number: 3, outcome: 'FAILED', http_status: 400 }),
      expect.objectContaining({ number: 2, outcome: 'FAILED', http_status: 503 }),
      expect.objectContaining({ number: 1, outcome: 'INTERRUPTED', http_status: null }),
    ]);
    const replay = (): request.Test =>
      request(server)
        .post(detail + '/replay')
        .auth(owner, { type: 'bearer' })
        .set('Idempotency-Key', 'webhook-replay');
    await replay().expect(202);
    await replay().expect(202).expect('Idempotency-Replayed', 'true');
    const delivered = await waitFor('DELIVERED');
    expect(delivered.attempt_history[0]).toMatchObject({ number: 4, outcome: 'DELIVERED' });
    expect(sent).toHaveLength(3);
    for (const notification of sent) {
      expect(notification.event).toMatchObject({ event_id: eventId, type: 'record.resolved' });
      expect(notification.signatureKey).toBe(signingSecret);
      expect(notification.body).not.toContain('fixture@example.test');
    }
    expect(sent[0]?.body).toBe(sent[2]?.body);
  });

  it('emits one terminal batch event and dead-letters when the configured retry budget runs out', async () => {
    const registered = await request(server)
      .post(basePath)
      .auth(owner, { type: 'bearer' })
      .send({
        url: 'https://batch.example.test/events',
        events: ['job.completed'],
        signing_secret: signingSecret,
      })
      .expect(201);
    const endpointId = (registered.body as WebhookEndpointDto).endpoint_id;
    jest
      .spyOn(WebhookTransport.prototype, 'send')
      .mockImplementation((target) =>
        Promise.resolve(new URL(target).hostname === 'batch.example.test' ? 503 : 204),
      );
    const { createWorker } = await import('../../apps/worker/src/worker.js');
    worker ??= await createWorker();
    const submit = (): request.Test =>
      request(server)
        .post('/v1/records/batch')
        .auth(owner, { type: 'bearer' })
        .set('Idempotency-Key', 'webhook-batch')
        .send({
          records: [
            {
              source: 'crm',
              external_id: 'batch-one',
              entity_type: 'person',
              data: { name: 'Webhook Batch Fixture' },
            },
          ],
        })
        .expect(202);
    const { job_id: jobId } = (await submit()).body as AcceptedBatchDto;
    await submit().expect('Idempotency-Replayed', 'true');
    const deadline = Date.now() + 15_000;
    let deadEvent: string | undefined;
    while (Date.now() < deadline) {
      const delivery = await prisma.webhookDelivery.findFirst({
        where: { tenantId, endpointId, status: 'DEAD_LETTER' },
        include: { attemptHistory: true, event: true },
      });
      if (delivery) {
        expect(delivery.attempts).toBe(3);
        expect(delivery.attemptHistory.map((attempt) => attempt.httpStatus)).toEqual([
          503, 503, 503,
        ]);
        expect(delivery.event.data).toEqual({ job_id: jobId, status: 'SUCCEEDED' });
        deadEvent = delivery.eventId;
        break;
      }
      await delay(100);
    }
    expect(deadEvent).toBeDefined();
    expect(await prisma.webhookEvent.count({ where: { tenantId, type: 'job.completed' } })).toBe(1);
  });
});
