import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateEnvironment } from '@resolve/config';

import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { BatchExecutionService } from './jobs/batch-execution.service.js';
import { RecordIngestionModule } from './records/record-ingestion.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ cache: true, isGlobal: true, validate: validateEnvironment }),
    InfrastructureModule,
    RecordIngestionModule,
  ],
  providers: [BatchExecutionService],
  exports: [BatchExecutionService],
})
export class BatchWorkerModule {}

export { ConfigService, BatchExecutionService };
export { BATCH_MAX_ATTEMPTS, type BatchIdentity } from './jobs/batch-execution.service.js';
