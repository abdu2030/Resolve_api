import { SetMetadata } from '@nestjs/common';
import type { ApiScope } from '@resolve/contracts';
import { REQUIRED_SCOPES } from './auth.constants.js';
export const RequireScopes = (...scopes: ApiScope[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);
