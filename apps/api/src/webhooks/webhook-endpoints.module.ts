import { Module } from '@nestjs/common';

import { WebhookEndpointService } from './webhook-endpoint.service.js';
import { WebhookEndpointsController } from './webhook-endpoints.controller.js';
import { WebhookSecretService } from './webhook-secret.service.js';
import { WebhookTransport } from './webhook-transport.js';

@Module({
  controllers: [WebhookEndpointsController],
  providers: [WebhookEndpointService, WebhookSecretService, WebhookTransport],
})
export class WebhookEndpointsModule {}
