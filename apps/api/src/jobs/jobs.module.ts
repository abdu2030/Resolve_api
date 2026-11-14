import { Module } from '@nestjs/common';
import { BatchJobController } from './batch-job.controller.js';
import { BatchJobService } from './batch-job.service.js';

@Module({ controllers: [BatchJobController], providers: [BatchJobService] })
export class JobsModule {}
