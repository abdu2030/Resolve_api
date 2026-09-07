import type { ApiScope } from '@resolve/contracts';
import type { Request } from 'express';

export interface AuthPrincipal {
  apiKeyId: string;
  tenantId: string;
  scopes: readonly ApiScope[];
}

export interface AuthenticatedRequest extends Request {
  principal?: AuthPrincipal;
}
