import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient } from '@resolve/database';
import { Redis } from 'ioredis';

import type { EnvironmentConfig } from '@resolve/config';

import { DATABASE_HEALTH_INDICATOR, REDIS_HEALTH_INDICATOR } from '../health/health.types.js';
import { DatabaseHealthIndicator } from './database-health.indicator.js';
import { InfrastructureLifecycleService } from './infrastructure-lifecycle.service.js';
import { PRISMA_CLIENT, REDIS_CLIENT } from './infrastructure.tokens.js';
import { RedisHealthIndicator } from './redis-health.indicator.js';

@Global()
@Module({
  exports: [DATABASE_HEALTH_INDICATOR, PRISMA_CLIENT, REDIS_CLIENT, REDIS_HEALTH_INDICATOR],
  providers: [
    {
      inject: [ConfigService],
      provide: PRISMA_CLIENT,
      useFactory: (config: ConfigService<EnvironmentConfig, true>) =>
        createPrismaClient(config.get('databaseUrl', { infer: true })),
    },
    {
      inject: [ConfigService],
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService<EnvironmentConfig, true>) => {
        const redis = new Redis({
          host: config.get('redisHost', { infer: true }),
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          port: config.get('redisPort', { infer: true }),
          commandTimeout: 1500,
          // An ambiguous Redis reply must not cause a quota mutation to run twice.
          enableOfflineQueue: false,
          autoResendUnfulfilledCommands: false,
        });
        const logger = new Logger(InfrastructureModule.name);
        redis.on('error', () => logger.warn({ event: 'redis.connection_error' }));
        return redis;
      },
    },
    DatabaseHealthIndicator,
    RedisHealthIndicator,
    {
      provide: DATABASE_HEALTH_INDICATOR,
      useExisting: DatabaseHealthIndicator,
    },
    {
      provide: REDIS_HEALTH_INDICATOR,
      useExisting: RedisHealthIndicator,
    },
    InfrastructureLifecycleService,
  ],
})
export class InfrastructureModule {}
