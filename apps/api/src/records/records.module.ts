import { Module } from '@nestjs/common';
import { ResolutionModule } from '../resolution/resolution.module.js';
import { RecordIngestionService } from './record-ingestion.service.js';
import { RecordsController } from './records.controller.js';

@Module({
  imports: [ResolutionModule],
  controllers: [RecordsController],
  providers: [RecordIngestionService],
})
export class RecordsModule {}
