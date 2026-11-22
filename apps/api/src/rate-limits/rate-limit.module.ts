import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimitService } from './rate-limit.service.js';

@Module({
  providers: [RateLimitService, { provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class RateLimitModule {}
