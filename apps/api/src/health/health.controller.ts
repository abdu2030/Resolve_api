import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from '../auth/public.decorator.js';

import { HealthService } from './health.service.js';
import type { HealthResponse } from './health.types.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get()
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const health = await this.healthService.check();
    if (health.status === 'error') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return health;
  }
}
