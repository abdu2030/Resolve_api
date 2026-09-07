import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from '@resolve/config';

import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { RecordsModule } from './records/records.module.js';
import { SourcesModule } from './sources/sources.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateEnvironment,
    }),
    InfrastructureModule,
    AuthModule,
    HealthModule,
    RecordsModule,
    SourcesModule,
  ],
})
export class AppModule {}
