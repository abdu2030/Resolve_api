import { Module } from '@nestjs/common';
import { RecordIngestionModule } from './record-ingestion.module.js';
import { RecordsController } from './records.controller.js';

@Module({
  imports: [RecordIngestionModule],
  controllers: [RecordsController],
})
export class RecordsModule {}
