import { Body, Controller, Headers, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { MergeEntityDto, SplitEntityDto } from '@resolve/contracts';
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../auth/auth-principal.js';
import { RequireScopes } from '../auth/require-scopes.decorator.js';
import { API_ERROR_SCHEMA } from '../common/http/api-error-schema.js';
import { ApiException } from '../common/http/api-exception.js';
import { validateIdempotencyKey } from '../records/idempotency-key.js';
import {
  EntityManagementService,
  type EntityOperationExecution,
} from './entity-management.service.js';
import { EntityOperationResponseDto } from './entity-operation-response.dto.js';

const versionSchema = { type: 'integer' as const, minimum: 0, maximum: 2147483647 };
const reasonSchema = { type: 'string' as const, minLength: 1, maxLength: 500 };
const uuidSchema = { type: 'string' as const, format: 'uuid' };

@ApiTags('entities')
@ApiBearerAuth('api-key')
@Controller('entities')
export class EntityManagementController {
  constructor(private readonly management: EntityManagementService) {}

  @Post(':entityId/merge')
  @RequireScopes('entities:merge')
  @ApiParam({ name: 'entityId', format: 'uuid' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '1-255 visible ASCII characters without whitespace',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'source_entity_id',
        'expected_source_version',
        'expected_target_version',
        'reason',
      ],
      properties: {
        source_entity_id: uuidSchema,
        expected_source_version: versionSchema,
        expected_target_version: versionSchema,
        reason: reasonSchema,
      },
    },
  })
  @ApiOkResponse({
    type: EntityOperationResponseDto,
    headers: {
      'Idempotency-Replayed': {
        schema: { type: 'string', enum: ['true'] },
        description: 'Present on successful replay',
      },
    },
  })
  @ApiBadRequestResponse({ schema: API_ERROR_SCHEMA })
  @ApiUnauthorizedResponse({ schema: API_ERROR_SCHEMA })
  @ApiForbiddenResponse({ schema: API_ERROR_SCHEMA })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  @ApiConflictResponse({ schema: API_ERROR_SCHEMA })
  @ApiUnprocessableEntityResponse({ schema: API_ERROR_SCHEMA })
  @ApiInternalServerErrorResponse({ schema: API_ERROR_SCHEMA })
  async merge(
    @Req() request: AuthenticatedRequest,
    @Param('entityId', new ParseUUIDPipe({ version: '4' })) entityId: string,
    @Body() input: MergeEntityDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EntityOperationResponseDto> {
    return respond(
      response,
      await this.management.merge(request.principal!, entityId, input, requiredKey(key)),
    );
  }

  @Post(':entityId/split')
  @RequireScopes('entities:split')
  @ApiParam({ name: 'entityId', format: 'uuid' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '1-255 visible ASCII characters without whitespace',
  })
  @ApiBody({
    schema: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['record_ids', 'expected_version', 'reason'],
          properties: {
            record_ids: {
              type: 'array',
              minItems: 1,
              maxItems: 1000,
              uniqueItems: true,
              items: uuidSchema,
            },
            expected_version: versionSchema,
            reason: reasonSchema,
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['merge_event_id', 'expected_version', 'reason'],
          properties: {
            merge_event_id: uuidSchema,
            expected_version: versionSchema,
            reason: reasonSchema,
          },
        },
      ],
    },
  })
  @ApiCreatedResponse({
    type: EntityOperationResponseDto,
    headers: {
      'Idempotency-Replayed': {
        schema: { type: 'string', enum: ['true'] },
        description: 'Present on successful replay',
      },
    },
  })
  @ApiOkResponse({
    type: EntityOperationResponseDto,
    description: 'Explicit merge reversal',
    headers: { 'Idempotency-Replayed': { schema: { type: 'string', enum: ['true'] } } },
  })
  @ApiBadRequestResponse({ schema: API_ERROR_SCHEMA })
  @ApiUnauthorizedResponse({ schema: API_ERROR_SCHEMA })
  @ApiForbiddenResponse({ schema: API_ERROR_SCHEMA })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  @ApiConflictResponse({ schema: API_ERROR_SCHEMA })
  @ApiUnprocessableEntityResponse({ schema: API_ERROR_SCHEMA })
  @ApiInternalServerErrorResponse({ schema: API_ERROR_SCHEMA })
  async split(
    @Req() request: AuthenticatedRequest,
    @Param('entityId', new ParseUUIDPipe({ version: '4' })) entityId: string,
    @Body() input: SplitEntityDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EntityOperationResponseDto> {
    return respond(
      response,
      await this.management.split(request.principal!, entityId, input, requiredKey(key)),
    );
  }
}
function requiredKey(value: string | undefined): string {
  const key = validateIdempotencyKey(value);
  if (key === undefined)
    throw new ApiException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
  return key;
}
function respond(
  response: Response,
  execution: EntityOperationExecution,
): EntityOperationResponseDto {
  response.status(execution.httpStatus);
  if (execution.replayed) response.setHeader('Idempotency-Replayed', 'true');
  return execution.body;
}
