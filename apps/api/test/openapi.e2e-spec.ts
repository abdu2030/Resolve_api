import type { Server } from 'node:http';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { configureApplication } from '../src/bootstrap.js';
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

interface OpenApiDocument {
  info: {
    title: string;
    version: string;
  };
  paths: Record<string, unknown>;
}

describe('OpenAPI document', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: CLOCK, useValue: clock },
        { provide: DATABASE_HEALTH_INDICATOR, useValue: up },
        { provide: REDIS_HEALTH_INDICATOR, useValue: up },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app, '1mb');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('publishes the service identity and health path', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/docs-json')
      .expect(200);
    const document = response.body as OpenApiDocument;

    expect(document.info).toMatchObject({
      title: 'Resolve API',
      version: '0.1.0',
    });
    expect(document.paths).toHaveProperty('/health');
  });
});
