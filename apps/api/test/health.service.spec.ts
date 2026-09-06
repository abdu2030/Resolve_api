import { HealthService } from '../src/health/health.service.js';
import type { Clock, HealthIndicator } from '../src/health/health.types.js';

const fixedClock: Clock = {
  now: () => new Date('2026-09-06T10:00:00.000Z'),
};
const up: HealthIndicator = {
  check: () => Promise.resolve(),
};

describe('HealthService', () => {
  it('reports ok when PostgreSQL and Redis respond', async () => {
    const service = new HealthService(up, up, fixedClock);

    await expect(service.check()).resolves.toEqual({
      checks: {
        database: 'up',
        redis: 'up',
      },
      service: 'resolve-api',
      status: 'ok',
      timestamp: '2026-09-06T10:00:00.000Z',
    });
  });

  it('reports a dependency as down without leaking its error', async () => {
    const down: HealthIndicator = {
      check: () => Promise.reject(new Error('password=do-not-leak')),
    };
    const service = new HealthService(up, down, fixedClock);

    const result = await service.check();

    expect(result).toEqual({
      checks: {
        database: 'up',
        redis: 'down',
      },
      service: 'resolve-api',
      status: 'error',
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('do-not-leak');
  });
});
