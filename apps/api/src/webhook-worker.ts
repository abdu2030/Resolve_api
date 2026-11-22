import { Module } from '@nestjs/common';
import { WebhookExecutionService } from './webhooks/webhook-execution.service.js';
import { WebhookSecretService } from './webhooks/webhook-secret.service.js';
import { WebhookTransport } from './webhooks/webhook-transport.js';

@Module({
  providers: [WebhookExecutionService, WebhookSecretService, WebhookTransport],
  exports: [WebhookExecutionService],
})
export class WebhookWorkerModule {}

export {
  WebhookExecutionService,
  type WebhookDispatch,
} from './webhooks/webhook-execution.service.js';
