import { Module } from '@nestjs/common';

import { CanonicalizationService } from './canonicalization.service.js';

@Module({
  providers: [CanonicalizationService],
  exports: [CanonicalizationService],
})
export class CanonicalizationModule {}
