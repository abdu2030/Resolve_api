import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import type { HealthIndicator } from '../health/health.types.js';
import { REDIS_CLIENT } from './infrastructure.tokens.js';

@Injectable()
export class RedisHealthIndicator implements HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async check(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
    const reply = await this.redis.ping();
    if (reply !== 'PONG') {
      throw new Error('Redis readiness check failed');
    }
  }
}
