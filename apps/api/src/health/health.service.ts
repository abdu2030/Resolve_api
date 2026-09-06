import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  DATABASE_HEALTH_INDICATOR,
  REDIS_HEALTH_INDICATOR,
  type Clock,
  type DependencyStatus,
  type HealthIndicator,
  type HealthResponse,
} from './health.types.js';

@Injectable()
export class HealthService {
  constructor(
    @Inject(DATABASE_HEALTH_INDICATOR) private readonly database: HealthIndicator,
    @Inject(REDIS_HEALTH_INDICATOR) private readonly redis: HealthIndicator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async check(): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([
      this.checkDependency(this.database),
      this.checkDependency(this.redis),
    ]);

    return {
      checks: { database, redis },
      service: 'resolve-api',
      status: database === 'up' && redis === 'up' ? 'ok' : 'error',
      timestamp: this.clock.now().toISOString(),
    };
  }

  private async checkDependency(indicator: HealthIndicator): Promise<DependencyStatus> {
    try {
      await indicator.check();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
