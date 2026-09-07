import { Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { CLOCK, SYSTEM_CLOCK } from './health.types.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService, { provide: CLOCK, useValue: SYSTEM_CLOCK }],
})
export class HealthModule {}
