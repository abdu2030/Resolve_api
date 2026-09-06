import type { Server } from 'node:http';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { HealthController } from '../src/health/health.controller.js';
import { HealthService } from '../src/health/health.service.js';
import {
  CLOCK,
  DATABASE_HEALTH_INDICATOR,
  REDIS_HEALTH_INDICATOR,
  type Clock,
  type HealthIndicator,
} from '../src/health/health.types.js';

const clock: Clock = {
  now: () => new Date('2026-09-06T10:00:00.000Z'),
};
const up: HealthIndicator = {
  check: () => Promise.resolve(),
};

async function createApp(redis: HealthIndicator): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      HealthService,
      { provide: CLOCK, useValue: clock },
      { provide: DATABASE_HEALTH_INDICATOR, useValue: up },
      { provide: REDIS_HEALTH_INDICATOR, useValue: redis },
    ],
  }).compile();
  const app = module.createNestApplication();
  await app.init();
  return app;
}

describe('GET /health', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns HTTP 200 and readiness details for healthy dependencies', async () => {
    app = await createApp(up);

    const response = await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200);

    expect(response.body).toEqual({
      checks: { database: 'up', redis: 'up' },
      service: 'resolve-api',
      status: 'ok',
      timestamp: '2026-09-06T10:00:00.000Z',
    });
  });

  it('returns HTTP 503 and a safe body when a dependency is down', async () => {
    app = await createApp({
      check: () => Promise.reject(new Error('redis://user:secret@internal')),
    });

    const response = await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(503);

    expect(response.body).toEqual({
      checks: { database: 'up', redis: 'down' },
      service: 'resolve-api',
      status: 'error',
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    expect(response.text).not.toContain('secret');
  });
});
