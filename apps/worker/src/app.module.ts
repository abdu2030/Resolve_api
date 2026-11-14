import { Module } from '@nestjs/common';
import { BatchWorkerModule } from '@resolve/api/batch-worker';
import { BatchQueueService } from './batch-queue.service.js';

@Module({
  imports: [BatchWorkerModule],
  providers: [BatchQueueService],
})
export class AppModule {}
