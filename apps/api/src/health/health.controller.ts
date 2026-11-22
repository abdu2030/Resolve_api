import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../auth/public.decorator.js';

import { HealthService } from './health.service.js';
import type { HealthResponse, LivenessResponse } from './health.types.js';

@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  live(): LivenessResponse {
    return this.healthService.live();
  }

  @Get(['', 'ready'])
  @ApiOkResponse({ description: 'Readiness dependencies are available.' })
  @ApiServiceUnavailableResponse({ description: 'A readiness dependency is unavailable.' })
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const health = await this.healthService.check();
    if (health.status === 'error') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return health;
  }
}
