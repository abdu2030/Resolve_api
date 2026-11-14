import { Module } from '@nestjs/common';
import { CanonicalizationModule } from '../canonicalization/canonicalization.module.js';
import { ResolutionModule } from '../resolution/resolution.module.js';
import { RecordIngestionService } from './record-ingestion.service.js';

@Module({
  imports: [CanonicalizationModule, ResolutionModule],
  providers: [RecordIngestionService],
  exports: [RecordIngestionService],
})
export class RecordIngestionModule {}
