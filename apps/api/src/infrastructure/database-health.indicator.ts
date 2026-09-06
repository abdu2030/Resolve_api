import { Inject, Injectable } from '@nestjs/common';
import type { ResolvePrismaClient } from '@resolve/database';

import type { HealthIndicator } from '../health/health.types.js';
import { PRISMA_CLIENT } from './infrastructure.tokens.js';

@Injectable()
export class DatabaseHealthIndicator implements HealthIndicator {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient) {}

  async check(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
