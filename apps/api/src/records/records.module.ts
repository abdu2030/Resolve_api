import { Module } from '@nestjs/common';
import { RecordIngestionService } from './record-ingestion.service.js';
import { RecordsController } from './records.controller.js';

@Module({ controllers: [RecordsController], providers: [RecordIngestionService] })
export class RecordsModule {}
