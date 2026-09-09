import { Module } from '@nestjs/common';

import { BlockingModule } from '../blocking/blocking.module.js';
import { ResolutionService } from './resolution.service.js';

@Module({
  imports: [BlockingModule],
  exports: [ResolutionService],
  providers: [ResolutionService],
})
export class ResolutionModule {}
