import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyAuthGuard } from './api-key-auth.guard.js';
import { ScopeGuard } from './scope.guard.js';

@Module({
  providers: [
    ApiKeyAuthGuard,
    ScopeGuard,
    { provide: APP_GUARD, useExisting: ApiKeyAuthGuard },
    { provide: APP_GUARD, useExisting: ScopeGuard },
  ],
})
export class AuthModule {}
