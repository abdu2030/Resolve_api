import type { Server } from 'node:http';
import 'reflect-metadata';

import { jest } from '@jest/globals';
import {
  Controller,
  Get,
  Global,
  Logger,
  Module,
  Post,
  type DynamicModule,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { hashApiKey } from '../auth/api-key.js';
import { AuthModule } from '../auth/auth.module.js';
import { Public } from '../auth/public.decorator.js';
import { configureApplication } from '../bootstrap.js';
import { ApiException } from '../common/http/api-exception.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { HttpObservabilityService } from './http-observability.service.js';
import { ObservabilityModule } from './observability.module.js';

const operatorToken = 'a'.repeat(64);
const tenantToken = 'rslv_test_abcdef123456.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const tenantId = '22222222-2222-4222-8222-222222222222';
const privateValue = 'private@example.test';

@Controller('observations')
class ObservabilityProbeController {
  @Get('records/:recordId')
  record(): object {
    return { ok: true };
  }

  @Public()
  @Get('throttled')
  throttled(): never {
    throw new ApiException(429, 'RATE_LIMITED', 'Rate limit exceeded');
  }

  @Public()
  @Get('failed')
  failed(): never {
    throw new Error(privateValue);
  }

  @Public()
  @Post('records')
  createRecord(): object {
    return { ok: true };
  }
}

const prisma = {
  apiKey: {
    findUnique: ({ where }: { where: { keyHash: string } }) =>
      where.keyHash === hashApiKey(tenantToken)
        ? {
            id: '11111111-1111-4111-8111-111111111111',
            tenantId,
            scopes: ['records:read'],
            revokedAt: null,
            tenant: { status: 'ACTIVE' },
          }
        : null,
    update: () => Promise.resolve(undefined),
  },
};

@Global()
@Module({})
class ObservabilityTestConfiguration {
  static configure(metricsToken?: string): DynamicModule {
    return {
      module: ObservabilityTestConfiguration,
      providers: [
        { provide: PRISMA_CLIENT, useValue: prisma },
        { provide: ConfigService, useValue: new ConfigService({ metricsToken }) },
      ],
      exports: [ConfigService, PRISMA_CLIENT],
    };
  }
}

describe('HTTP observability', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    jest.restoreAllMocks();
  });

  async function createApp(metricsToken?: string): Promise<Server> {
    const fixture = await Test.createTestingModule({
      imports: [
        ObservabilityTestConfiguration.configure(metricsToken),
        AuthModule,
        ObservabilityModule,
      ],
      controllers: [ObservabilityProbeController],
    }).compile();
    app = fixture.createNestApplication({ bodyParser: false, logger: false });
    configureApplication(app, '1mb', app.get(HttpObservabilityService));
    await app.init();
    return app.getHttpServer() as Server;
  }

  it('returns 404 for metrics when the operator token is unset', async () => {
    const server = await createApp();

    const response = await request(server)
      .get('/metrics')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(404);

    expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
  });

  it('isolates the unversioned scrape from tenant authentication', async () => {
    const server = await createApp(operatorToken);
    const path = '/v1/observations/records/example';

    await request(server).get(path).set('Authorization', `Bearer ${tenantToken}`).expect(200);
    await request(server).get(path).set('Authorization', `Bearer ${operatorToken}`).expect(401);
    await request(server).get('/metrics').expect(401).expect('WWW-Authenticate', 'Bearer');
    await request(server).get('/metrics').set('Authorization', `Bearer ${tenantToken}`).expect(401);
    await request(server)
      .get('/metrics')
      .set('Authorization', `Bearer ${'b'.repeat(64)}`)
      .expect(401);
    await request(server)
      .get('/metrics')
      .set('Authorization', `Bearer ${operatorToken.toUpperCase()}`)
      .expect(401);
    const scrape = await request(server)
      .get('/metrics')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect('Content-Type', /^text\/plain\b.*;\s*version=0\.0\.4\b/)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    await request(server).get('/v1/metrics').expect(404);

    expect(scrape.text).toContain('# TYPE resolve_http_requests_total counter');
  });

  it('keeps the operator scrape out of the tenant OpenAPI document', async () => {
    const server = await createApp(operatorToken);
    const response = await request(server).get('/docs-json').expect(200);
    const document = response.body as { paths: Record<string, unknown> };

    expect(document.paths).not.toHaveProperty('/metrics');
  });

  it('aggregates HTTP outcomes and latency without request or tenant labels', async () => {
    const server = await createApp(operatorToken);

    await request(server)
      .get('/v1/observations/records/private-id')
      .query({ email: privateValue })
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200);
    await request(server).get('/v1/observations/throttled').expect(429);
    await request(server).get('/v1/observations/failed').expect(500);
    await request(server)
      .post('/v1/observations/records')
      .set('Content-Type', 'application/json')
      .send(`{"email":"${privateValue}"`)
      .expect(400);

    const scrape = await request(server)
      .get('/metrics')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(scrape.text).toContain('resolve_http_requests_total{method="GET",status="200"} 1\n');
    expect(scrape.text).toContain('resolve_http_requests_total{method="GET",status="429"} 1\n');
    expect(scrape.text).toContain('resolve_http_requests_total{method="GET",status="500"} 1\n');
    expect(scrape.text).toContain('resolve_http_requests_total{method="POST",status="400"} 1\n');
    expect(scrape.text).toContain('resolve_http_rate_limited_total 1\n');
    expect(scrape.text).toContain('resolve_http_errors_total 3\n');
    expect(scrape.text).toContain(
      'resolve_http_request_duration_seconds_bucket{method="GET",le="+Inf"} 3\n',
    );
    expect(scrape.text).toContain('resolve_http_request_duration_seconds_count{method="POST"} 1\n');
    for (const secret of [tenantId, privateValue, 'private-id', operatorToken, tenantToken]) {
      expect(scrape.text).not.toContain(secret);
    }
  });

  it('logs request completion using a generated ID and the matched route template', async () => {
    const server = await createApp(operatorToken);
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const matched = await request(server)
      .get('/v1/observations/records/private-id')
      .query({ email: privateValue })
      .set('X-Request-Id', 'client-supplied-private-id')
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200);
    const unmatched = await request(server).get('/unmatched-private-path').expect(404);

    const matchedId = matched.get('X-Request-Id');
    const unmatchedId = unmatched.get('X-Request-Id');
    const durationMs: unknown = expect.any(Number);
    expect(matchedId).toMatch(/^[0-9a-f-]{36}$/);
    expect(unmatchedId).toMatch(/^[0-9a-f-]{36}$/);
    expect(matchedId).not.toBe(unmatchedId);
    expect(logs).toHaveBeenCalledTimes(2);
    expect(logs).toHaveBeenCalledWith({
      event: 'http.request.completed',
      method: 'GET',
      route: '/v1/observations/records/:recordId',
      requestId: matchedId,
      status: 200,
      durationMs,
    });
    expect(logs).toHaveBeenCalledWith({
      event: 'http.request.completed',
      method: 'GET',
      route: 'unmatched',
      requestId: unmatchedId,
      status: 404,
      durationMs,
    });
    for (const secret of [privateValue, 'private-id', 'unmatched-private-path', tenantToken]) {
      expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
    }
  });
});
