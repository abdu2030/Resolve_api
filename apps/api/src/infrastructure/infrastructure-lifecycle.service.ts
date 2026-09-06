import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { ResolvePrismaClient } from '@resolve/database';
import type { Redis } from 'ioredis';

import { PRISMA_CLIENT, REDIS_CLIENT } from './infrastructure.tokens.js';

@Injectable()
export class InfrastructureLifecycleService implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.prisma.$disconnect();
  }
}
