import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiScope } from '@resolve/contracts';

import { ApiException } from '../common/http/api-exception.js';
import { REQUIRED_SCOPES } from './auth.constants.js';
import type { AuthenticatedRequest } from './auth-principal.js';

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<ApiScope[]>(REQUIRED_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length === 0) return true;
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal || required.some((scope) => !principal.scopes.includes(scope))) {
      throw new ApiException(403, 'INSUFFICIENT_SCOPE', 'API key lacks a required scope');
    }
    return true;
  }
}
