import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../auth/auth-principal.js';
import { RequireScopes } from '../auth/require-scopes.decorator.js';
import { API_ERROR_SCHEMA } from '../common/http/api-error-schema.js';
import { ApiException } from '../common/http/api-exception.js';
import { validateIdempotencyKey } from '../records/idempotency-key.js';
import { WebhookEndpointService } from './webhook-endpoint.service.js';
import {
  RegisterWebhookEndpointDto,
  WebhookDeliveryDetailDto,
  WebhookDeliveryPageDto,
  WebhookDeliveryQueryDto,
  WebhookEndpointDto,
  WebhookReplayDto,
} from './webhook.dto.js';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('webhooks')
@ApiBearerAuth('api-key')
@ApiBadRequestResponse({ schema: API_ERROR_SCHEMA })
@ApiUnauthorizedResponse({ schema: API_ERROR_SCHEMA })
@ApiForbiddenResponse({ schema: API_ERROR_SCHEMA })
@RequireScopes('webhooks:manage')
@Controller('webhook-endpoints')
export class WebhookEndpointsController {
  constructor(private readonly endpoints: WebhookEndpointService) {}

  @Post()
  @ApiCreatedResponse({ type: WebhookEndpointDto })
  @ApiConflictResponse({ schema: API_ERROR_SCHEMA })
  @ApiUnprocessableEntityResponse({ schema: API_ERROR_SCHEMA })
  @ApiServiceUnavailableResponse({ schema: API_ERROR_SCHEMA })
  register(
    @Req() request: AuthenticatedRequest,
    @Body() input: RegisterWebhookEndpointDto,
  ): Promise<WebhookEndpointDto> {
    return this.endpoints.register(request.principal!.tenantId, input);
  }

  @Get(':endpointId/deliveries')
  @ApiOkResponse({ type: WebhookDeliveryPageDto })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  list(
    @Req() request: AuthenticatedRequest,
    @Param('endpointId', uuid) endpointId: string,
    @Query() query: WebhookDeliveryQueryDto,
  ): Promise<WebhookDeliveryPageDto> {
    return this.endpoints.list(request.principal!.tenantId, endpointId, query.cursor);
  }

  @Get(':endpointId/deliveries/:eventId')
  @ApiOkResponse({ type: WebhookDeliveryDetailDto })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  get(
    @Req() request: AuthenticatedRequest,
    @Param('endpointId', uuid) endpointId: string,
    @Param('eventId', uuid) eventId: string,
  ): Promise<WebhookDeliveryDetailDto> {
    return this.endpoints.get(request.principal!.tenantId, endpointId, eventId);
  }

  @Post(':endpointId/deliveries/:eventId/replay')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: WebhookReplayDto })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  @ApiConflictResponse({ schema: API_ERROR_SCHEMA })
  async replay(
    @Req() request: AuthenticatedRequest,
    @Param('endpointId', uuid) endpointId: string,
    @Param('eventId', uuid) eventId: string,
    @Headers('idempotency-key') header: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WebhookReplayDto> {
    const key = validateIdempotencyKey(header);
    if (!key)
      throw new ApiException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
    const result = await this.endpoints.replay(
      request.principal!.tenantId,
      endpointId,
      eventId,
      key,
    );
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }
}
