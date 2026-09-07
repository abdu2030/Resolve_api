import type { Server } from 'node:http';
import 'reflect-metadata';

import { Body, Controller, Get, Module, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { configureApplication } from '../../bootstrap.js';
import { ApiException } from './api-exception.js';
import type { RawBodyRequest } from './raw-body-request.js';

@Controller()
class BoundaryController {
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
}

@Module({ controllers: [BoundaryController] })
class BoundaryModule {}

describe('HTTP boundary', () => {
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
});
