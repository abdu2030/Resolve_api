import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentConfig } from '@resolve/config';
import type { Redis } from 'ioredis';

import type { AuthPrincipal } from '../auth/auth-principal.js';
import { ApiException } from '../common/http/api-exception.js';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.tokens.js';

// Check every relevant budget before charging any of them. Redis serializes
// the script across all API processes, including requests that race for the last slot.
const CONSUME_REQUEST_BUDGETS = `
local window = tonumber(ARGV[1])
local retryAfter = 0
for i, key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  if count >= tonumber(ARGV[i + 1]) then
    local remaining = redis.call('PTTL', key)
    if remaining < 0 then
      redis.call('PEXPIRE', key, window)
      remaining = window
    end
    retryAfter = math.max(retryAfter, remaining, 1)
  end
end
if retryAfter > 0 then
  return retryAfter
end

for _, key in ipairs(KEYS) do
  if redis.call('INCR', key) == 1 then
    redis.call('PEXPIRE', key, window)
  end
end
return 0
`;

@Injectable()
export class RateLimitService implements OnApplicationBootstrap {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService<EnvironmentConfig, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.redis.status !== 'wait') return;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.redis.connect(),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 1000);
        }),
      ]);
    } catch {
      // Keep liveness available. The Redis client reconnects and readiness reflects its state.
    } finally {
      clearTimeout(deadline);
    }
  }

  async consume(principal: AuthPrincipal, isBatch: boolean): Promise<number> {
    const deployment = this.config.get('batchQueuePrefix', { infer: true });
    // The keys share a tenant hash tag so the same operation is safe on Redis Cluster.
    const namespace = `${deployment}:rate-limit:{${principal.tenantId}}`;
    const keySuffix = `key:${principal.apiKeyId}`;
    const keys = [`${namespace}:tenant`, `${namespace}:${keySuffix}`];
    const limits = [
      this.config.get('rateLimitTenantMax', { infer: true }),
      this.config.get('rateLimitKeyMax', { infer: true }),
    ];
    if (isBatch) {
      keys.push(`${namespace}:batch:tenant`, `${namespace}:batch:${keySuffix}`);
      limits.push(
        this.config.get('rateLimitBatchTenantMax', { infer: true }),
        this.config.get('rateLimitBatchKeyMax', { infer: true }),
      );
    }

    const windowMs = 1000 * this.config.get('rateLimitWindowSeconds', { infer: true });
    try {
      const waitMs = await this.redis.eval(
        CONSUME_REQUEST_BUDGETS,
        keys.length,
        ...keys,
        windowMs,
        ...limits,
      );
      if (typeof waitMs === 'number' && Number.isSafeInteger(waitMs) && waitMs >= 0) {
        return Math.ceil(waitMs / 1000);
      }
    } catch {
      // The response has a stable code even when Redis reports internal connection details.
    }
    throw new ApiException(
      503,
      'RATE_LIMIT_UNAVAILABLE',
      'Request rate limit is temporarily unavailable',
    );
  }
}
