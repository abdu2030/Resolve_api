import type { Server } from 'node:http';
import 'reflect-metadata';

import { Controller, Get, Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';

import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { AuthModule } from './auth.module.js';
import { hashApiKey } from './api-key.js';
import { Public } from './public.decorator.js';
import { RequireScopes } from './require-scopes.decorator.js';

const token = 'rslv_test_abcdef123456.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
let apiKeyRow: object | null;

const prisma = {
  apiKey: {
    findUnique: jest.fn(({ where }: { where: { keyHash: string } }) =>
      where.keyHash === hashApiKey(token) ? apiKeyRow : null,
    ),
    update: jest.fn(() => Promise.resolve(undefined)),
  },
};

@Controller()
class AuthProbeController {
  @Public()
  @Get('public-probe')
  publicProbe(): object {
    return { ok: true };
  }

  @RequireScopes('records:write')
  @Get('protected-probe')
  protectedProbe(): object {
    return { ok: true };
  }
}

@Global()
@Module({
  exports: [PRISMA_CLIENT],
  providers: [{ provide: PRISMA_CLIENT, useValue: prisma }],
})
class TestDatabaseModule {}

@Module({ controllers: [AuthProbeController], imports: [TestDatabaseModule, AuthModule] })
class AuthProbeModule {}

describe('API-key authentication and scopes', () => {
  const activeKey = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    scopes: ['records:write'],
    revokedAt: null,
    tenant: { status: 'ACTIVE' },
  };

  async function createApp(): Promise<INestApplication> {
    const fixture = await Test.createTestingModule({ imports: [AuthProbeModule] }).compile();
    const app = fixture.createNestApplication();
    await app.init();
    return app;
  }

  beforeEach(() => {
    apiKeyRow = activeKey;
    jest.clearAllMocks();
  });

  it('allows explicitly public routes without credentials', async () => {
    const app = await createApp();
    const response = await request(app.getHttpServer() as Server)
      .get('/public-probe')
      .expect(200, { ok: true });
    expect(response.status).toBe(200);
    await app.close();
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'Basic abc'],
    ['unknown', 'Bearer unknown'],
  ])('rejects a %s credential with 401', async (_name, authorization) => {
    if (authorization === 'Bearer unknown') apiKeyRow = null;
    const app = await createApp();
    const call = request(app.getHttpServer() as Server).get('/protected-probe');
    if (authorization) call.set('Authorization', authorization);
    expect((await call).status).toBe(401);
    await app.close();
  });

  it.each([
    ['revoked key', { ...activeKey, revokedAt: new Date() }],
    ['inactive tenant', { ...activeKey, tenant: { status: 'SUSPENDED' } }],
  ])('rejects an authenticated %s with 401', async (_name, row) => {
    apiKeyRow = row;
    const app = await createApp();
    const response = await request(app.getHttpServer() as Server)
      .get('/protected-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(response.status).toBe(401);
    await app.close();
  });

  it('rejects a key without the required scope with 403', async () => {
    apiKeyRow = { ...activeKey, scopes: ['sources:write'] };
    const app = await createApp();
    const response = await request(app.getHttpServer() as Server)
      .get('/protected-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(response.status).toBe(403);
    await app.close();
  });

  it('attaches an active scoped key and records its use', async () => {
    const app = await createApp();
    await request(app.getHttpServer() as Server)
      .get('/protected-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, { ok: true });
    expect(prisma.apiKey.update).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
