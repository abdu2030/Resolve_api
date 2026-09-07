import { Body, Controller, Headers, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { EntityType, RecordInputDto } from '@resolve/contracts';
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../auth/auth-principal.js';
import { RequireScopes } from '../auth/require-scopes.decorator.js';
import { API_ERROR_SCHEMA } from '../common/http/api-error-schema.js';
import { ApiException } from '../common/http/api-exception.js';
import type { RawBodyRequest } from '../common/http/raw-body-request.js';
import { validateIdempotencyKey } from './idempotency-key.js';
import { RecordIngestionService } from './record-ingestion.service.js';
import { RecordResponseDto } from './record-response.dto.js';

@ApiTags('records')
@ApiBearerAuth('api-key')
@Controller('records')
export class RecordsController {
  constructor(private readonly ingestion: RecordIngestionService) {}

  @Post()
  @RequireScopes('records:write')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: '1-255 visible ASCII characters without whitespace',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['source', 'external_id', 'entity_type', 'data'],
      additionalProperties: false,
      properties: {
        source: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', maxLength: 120 },
        external_id: { type: 'string', maxLength: 255 },
        entity_type: { type: 'string', enum: Object.values(EntityType) },
        data: {
          type: 'object',
          description: 'Validated Person or Company payload',
          additionalProperties: true,
        },
      },
    },
  })
  @ApiCreatedResponse({ type: RecordResponseDto })
  @ApiOkResponse({ type: RecordResponseDto })
  @ApiBadRequestResponse({ schema: API_ERROR_SCHEMA })
  @ApiUnauthorizedResponse({ schema: API_ERROR_SCHEMA })
  @ApiForbiddenResponse({ schema: API_ERROR_SCHEMA })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  @ApiConflictResponse({ schema: API_ERROR_SCHEMA })
  async create(
    @Req() request: AuthenticatedRequest & RawBodyRequest,
    @Body() input: RecordInputDto,
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RecordResponseDto> {
    const idempotencyKey = validateIdempotencyKey(idempotencyHeader);
    const rawData = extractRawData(request.rawBody);
    const result = await this.ingestion.ingest(
      request.principal!.tenantId,
      input,
      rawData,
      idempotencyKey,
    );
    response.status(result.httpStatus);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }
}

function extractRawData(rawBody: Buffer | undefined): Record<string, unknown> {
  if (!rawBody)
    throw new ApiException(400, 'INVALID_REQUEST_BODY', 'Original request body is unavailable');
  const envelope = JSON.parse(rawBody.toString('utf8')) as { data?: unknown };
  if (typeof envelope.data !== 'object' || envelope.data === null || Array.isArray(envelope.data)) {
    throw new ApiException(400, 'INVALID_REQUEST_BODY', 'Record data must be an object');
  }
  return envelope.data as Record<string, unknown>;
}
