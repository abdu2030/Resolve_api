import type { Server } from 'node:http';
import 'reflect-metadata';

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  InternalServerErrorException,
  Module,
  Post,
  Req,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { configureApplication } from '../../bootstrap.js';
import { ApiException } from './api-exception.js';
import type { RawBodyRequest } from './raw-body-request.js';

@Controller()
class BoundaryController {
  @Get('invalid')
  invalid(): never {
    throw new BadRequestException(['Unknown actor field']);
  }
  @Post('probe')
  probe(@Req() request_: RawBodyRequest, @Body() body: unknown): object {
    return { body, raw: request_.rawBody?.toString('utf8') };
  }

  @Get('problem')
  problem(): never {
    throw new ApiException(
      409,
      'SOURCE_TYPE_CONFLICT',
      'Source type conflicts with existing source',
    );
  }

  @Get('internal-error')
  internalError(): never {
    throw new InternalServerErrorException('private-internal-details');
  }

  @Get('untrusted-error-envelope')
  untrustedErrorEnvelope(): never {
    throw new HttpException(
      { error: { code: 'UNSAFE', message: 'private-internal-details' } },
      503,
    );
  }
}

@Module({ controllers: [BoundaryController] })
class BoundaryModule {}

describe('HTTP boundary', () => {
  it('maps Nest validation exceptions into the safe error envelope', async () => {
    const fixture = await Test.createTestingModule({ imports: [BoundaryModule] }).compile();
    const app = fixture.createNestApplication({ bodyParser: false });
    configureApplication(app, '1mb');
    await app.init();
    try {
      const response = await request(app.getHttpServer() as Server).get('/v1/invalid');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: 'BAD_REQUEST',
          message: 'Request validation failed',
          details: { messages: ['Unknown actor field'] },
        },
      });
    } finally {
      await app.close();
    }
  });
  it('keeps the original JSON bytes available after parsing', async () => {
    const fixture = await Test.createTestingModule({ imports: [BoundaryModule] }).compile();
    const app = fixture.createNestApplication({ bodyParser: false });
    configureApplication(app, '1mb');
    await app.init();

    const rawJson = '{"data":{"address":{"country":"et"}}}';
    const response = await request(app.getHttpServer() as Server)
      .post('/v1/probe')
      .set('Content-Type', 'application/json')
      .send(rawJson)
      .expect(201);

    expect(response.body).toEqual({ raw: rawJson, body: { data: { address: { country: 'et' } } } });
    await app.close();
  });

  it('returns the stable safe error envelope', async () => {
    const fixture = await Test.createTestingModule({ imports: [BoundaryModule] }).compile();
    const app = fixture.createNestApplication({ bodyParser: false });
    configureApplication(app, '1mb');
    await app.init();

    const response = await request(app.getHttpServer() as Server)
      .get('/v1/problem')
      .expect(409, {
        error: {
          code: 'SOURCE_TYPE_CONFLICT',
          message: 'Source type conflicts with existing source',
        },
      });
    expect(response.status).toBe(409);
    await app.close();
  });

  it.each([
    [
      'malformed JSON',
      '{"email":"private@example.test"',
      400,
      'BAD_REQUEST',
      'Malformed JSON body',
    ],
    [
      'oversized JSON',
      JSON.stringify({ email: 'private@example.test'.repeat(6) }),
      413,
      'PAYLOAD_TOO_LARGE',
      'Request body exceeds the size limit',
    ],
  ])('returns a safe HTTP error for %s', async (_scenario, body, status, code, message) => {
    const fixture = await Test.createTestingModule({ imports: [BoundaryModule] }).compile();
    const app = fixture.createNestApplication({ bodyParser: false, logger: false });
    configureApplication(app, '100b');
    await app.init();
    try {
      const response = await request(app.getHttpServer() as Server)
        .post('/v1/probe')
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(status);

      expect(response.body).toEqual({ error: { code, message } });
      expect(response.text).not.toContain('private@example.test');
    } finally {
      await app.close();
    }
  });

  it('masks details from explicit server errors', async () => {
    const fixture = await Test.createTestingModule({ imports: [BoundaryModule] }).compile();
    const app = fixture.createNestApplication({ bodyParser: false, logger: false });
    configureApplication(app, '100b');
    await app.init();
    try {
      const response = await request(app.getHttpServer() as Server).get('/v1/internal-error');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
    } finally {
      await app.close();
    }
  });

  it('masks untrusted error envelopes while preserving their HTTP status', async () => {
    const fixture = await Test.createTestingModule({ imports: [BoundaryModule] }).compile();
    const app = fixture.createNestApplication({ bodyParser: false, logger: false });
    configureApplication(app, '100b');
    await app.init();
    try {
      const response = await request(app.getHttpServer() as Server).get(
        '/v1/untrusted-error-envelope',
      );

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' },
      });
    } finally {
      await app.close();
    }
  });
});
