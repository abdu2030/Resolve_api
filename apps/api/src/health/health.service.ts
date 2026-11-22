import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  DATABASE_HEALTH_INDICATOR,
  REDIS_HEALTH_INDICATOR,
  type Clock,
  type DependencyStatus,
  type HealthIndicator,
  type HealthResponse,
  type LivenessResponse,
} from './health.types.js';

const PROBE_TIMEOUT_MS = 1_000;

@Injectable()
export class HealthService {
  constructor(
    @Inject(DATABASE_HEALTH_INDICATOR) private readonly database: HealthIndicator,
    @Inject(REDIS_HEALTH_INDICATOR) private readonly redis: HealthIndicator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  live(): LivenessResponse {
    return {
      service: 'resolve-api',
      status: 'ok',
      timestamp: this.clock.now().toISOString(),
    };
  }

  async check(): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([
      this.checkDependency(this.database),
      this.checkDependency(this.redis),
    ]);

    return {
      checks: { database, redis },
      ...this.live(),
      status: database === 'up' && redis === 'up' ? 'ok' : 'error',
    };
  }

  private async checkDependency(indicator: HealthIndicator): Promise<DependencyStatus> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        indicator.check().then(() => 'up' as const),
        new Promise<DependencyStatus>((resolve) => {
          timeout = setTimeout(() => resolve('down'), PROBE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return 'down';
    } finally {
      clearTimeout(timeout);
    }
  }
}
