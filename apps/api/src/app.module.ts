import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from '@resolve/config';

import { AuthModule } from './auth/auth.module.js';
import { BlockingModule } from './blocking/blocking.module.js';
import { EntitiesModule } from './entities/entities.module.js';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { RateLimitModule } from './rate-limits/rate-limit.module.js';
import { RecordsModule } from './records/records.module.js';
import { SourcesModule } from './sources/sources.module.js';
import { ReviewsModule } from './reviews/reviews.module.js';
import { WebhookEndpointsModule } from './webhooks/webhook-endpoints.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateEnvironment,
    }),
    InfrastructureModule,
    AuthModule,
    RateLimitModule,
    BlockingModule,
    EntitiesModule,
    HealthModule,
    ObservabilityModule,
    JobsModule,
    RecordsModule,
    SourcesModule,
    ReviewsModule,
    WebhookEndpointsModule,
  ],
})
export class AppModule {}
