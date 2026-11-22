import { Module } from '@nestjs/common';
import { BatchWorkerModule } from '@resolve/api/batch-worker';
import { WebhookWorkerModule } from '@resolve/api/webhook-worker';
import { BatchQueueService } from './batch-queue.service.js';
import { WebhookQueueService } from './webhook-queue.service.js';

@Module({
  imports: [BatchWorkerModule, WebhookWorkerModule],
  providers: [BatchQueueService, WebhookQueueService],
})
export class AppModule {}
