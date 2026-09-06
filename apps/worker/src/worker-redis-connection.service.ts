import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentConfig } from '@resolve/config';
import { Redis } from 'ioredis';

@Injectable()
export class WorkerRedisConnectionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private redis?: Redis;

  constructor(private readonly config: ConfigService<EnvironmentConfig, true>) {}

  async onApplicationBootstrap(): Promise<void> {
    this.redis = new Redis({
      host: this.config.get('redisHost', { infer: true }),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      port: this.config.get('redisPort', { infer: true }),
    });
    await this.redis.connect();
    const reply = await this.redis.ping();
    if (reply !== 'PONG') {
      throw new Error('Worker Redis readiness check failed');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}
