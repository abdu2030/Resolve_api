import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiScope } from '@resolve/contracts';
import type { ResolvePrismaClient } from '@resolve/database';

import { ApiException } from '../common/http/api-exception.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { extractBearerToken, hashApiKey } from './api-key.js';
import { PUBLIC_ROUTE } from './auth.constants.js';
import type { AuthenticatedRequest } from './auth-principal.js';

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.header('authorization'));
    if (!token) throw unauthorized();
    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(token) },
      include: { tenant: true },
    });
    if (!key || key.revokedAt || key.tenant.status !== 'ACTIVE') throw unauthorized();
    request.principal = {
      apiKeyId: key.id,
      tenantId: key.tenantId,
      scopes: key.scopes as ApiScope[],
    };
    await this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    return true;
  }
}

function unauthorized(): ApiException {
  return new ApiException(401, 'UNAUTHORIZED', 'A valid API key is required');
}
