import { Module } from '@nestjs/common';

import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { CLOCK, SYSTEM_CLOCK } from './health.types.js';

@Module({
  controllers: [HealthController],
  imports: [InfrastructureModule],
  providers: [HealthService, { provide: CLOCK, useValue: SYSTEM_CLOCK }],
})
export class HealthModule {}
