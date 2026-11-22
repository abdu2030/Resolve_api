import { timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Get,
  Header,
  Injectable,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { EnvironmentConfig } from '@resolve/config';
import type { Request, Response } from 'express';

import { Public } from '../auth/public.decorator.js';
import { ApiException } from '../common/http/api-exception.js';
import { HttpObservabilityService } from './http-observability.service.js';

@Injectable()
class MetricsTokenGuard implements CanActivate {
  private readonly token: Buffer | undefined;

  constructor(config: ConfigService<EnvironmentConfig, true>) {
    const token = config.get('metricsToken', { infer: true });
    this.token = token === undefined ? undefined : Buffer.from(token, 'ascii');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.token) throw new ApiException(404, 'NOT_FOUND', 'Resource not found');

    const http = context.switchToHttp();
    const authorization = http.getRequest<Request>().header('authorization');
    const token = /^Bearer +([0-9a-f]{64})$/i.exec(authorization ?? '')?.[1];
    if (token && timingSafeEqual(Buffer.from(token, 'ascii'), this.token)) return true;

    http.getResponse<Response>().setHeader('WWW-Authenticate', 'Bearer');
    throw new ApiException(401, 'UNAUTHORIZED', 'A valid metrics token is required');
  }
}

@ApiExcludeController()
@Controller('metrics')
@Public()
@UseGuards(MetricsTokenGuard)
export class MetricsController {
  constructor(private readonly observability: HttpObservabilityService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): string {
    return this.observability.renderMetrics();
  }
}
