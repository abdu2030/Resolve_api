import { Module } from '@nestjs/common';

import { HttpObservabilityService } from './http-observability.service.js';
import { MetricsController } from './metrics.controller.js';

@Module({
  controllers: [MetricsController],
  exports: [HttpObservabilityService],
  providers: [HttpObservabilityService],
})
export class ObservabilityModule {}
