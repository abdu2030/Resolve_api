import { Module } from '@nestjs/common';

import { CandidateGenerationService } from './candidate-generation.service.js';

@Module({
  exports: [CandidateGenerationService],
  providers: [CandidateGenerationService],
})
export class BlockingModule {}
