import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { type EnvironmentConfig, validateEnvironment } from '@resolve/config';

import { WorkerRedisConnectionService } from './worker-redis-connection.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateEnvironment,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentConfig, true>) => ({
        connection: {
          host: config.get('redisHost', { infer: true }),
          port: config.get('redisPort', { infer: true }),
        },
      }),
    }),
  ],
  providers: [WorkerRedisConnectionService],
})
export class AppModule {}
