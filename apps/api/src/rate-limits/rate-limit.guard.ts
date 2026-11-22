import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../auth/auth-principal.js';
import { ApiException } from '../common/http/api-exception.js';
import { RateLimitService } from './rate-limit.service.js';

const BATCH_QUOTA = Symbol('resolve.batchQuota');

export const LimitBatchRate = (): MethodDecorator => SetMetadata(BATCH_QUOTA, true);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimits: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const { principal } = http.getRequest<AuthenticatedRequest>();
    if (!principal) return true;

    const isBatch = this.reflector.get<boolean>(BATCH_QUOTA, context.getHandler()) ?? false;
    const retryAfter = await this.rateLimits.consume(principal, isBatch);
    if (retryAfter === 0) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(retryAfter));
    throw new ApiException(429, 'RATE_LIMIT_EXCEEDED', 'Request rate limit exceeded');
  }
}
