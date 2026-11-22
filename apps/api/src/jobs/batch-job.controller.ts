import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { BATCH_MAX_RECORDS, BatchInputDto } from '@resolve/contracts';
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../auth/auth-principal.js';
import { RequireScopes } from '../auth/require-scopes.decorator.js';
import { API_ERROR_SCHEMA } from '../common/http/api-error-schema.js';
import { ApiException } from '../common/http/api-exception.js';
import type { RawBodyRequest } from '../common/http/raw-body-request.js';
import { LimitBatchRate } from '../rate-limits/rate-limit.guard.js';
import { validateIdempotencyKey } from '../records/idempotency-key.js';
import { ApiRecordBodyErrors, RECORD_REQUEST_SCHEMA } from '../records/record-request.openapi.js';
import { AcceptedBatchDto, BatchJobDto } from './batch-job.dto.js';
import { BatchJobService, type StoredBatchRecord } from './batch-job.service.js';

@ApiTags('jobs')
@ApiBearerAuth('api-key')
@ApiBadRequestResponse({ schema: API_ERROR_SCHEMA })
@ApiUnauthorizedResponse({ schema: API_ERROR_SCHEMA })
@ApiForbiddenResponse({ schema: API_ERROR_SCHEMA })
@ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
@Controller()
export class BatchJobController {
  constructor(private readonly jobs: BatchJobService) {}

  @Post('records/batch')
  @LimitBatchRate()
  @HttpCode(202)
  @RequireScopes('records:write')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '1-255 visible ASCII characters without whitespace',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['records'],
      additionalProperties: false,
      properties: {
        records: {
          type: 'array',
          minItems: 1,
          maxItems: BATCH_MAX_RECORDS,
          items: RECORD_REQUEST_SCHEMA,
        },
      },
    },
  })
  @ApiRecordBodyErrors()
  @ApiAcceptedResponse({
    type: AcceptedBatchDto,
    headers: { Location: { schema: { type: 'string' } } },
  })
  @ApiConflictResponse({ schema: API_ERROR_SCHEMA })
  async submit(
    @Req() request: AuthenticatedRequest & RawBodyRequest,
    @Body() input: BatchInputDto,
    @Headers('idempotency-key') header: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AcceptedBatchDto> {
    const key = validateIdempotencyKey(header);
    if (!key)
      throw new ApiException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
    if (!request.rawBody)
      throw new ApiException(400, 'INVALID_REQUEST_BODY', 'Original request body is unavailable');
    const raw = JSON.parse(request.rawBody.toString('utf8')) as { records: StoredBatchRecord[] };
    const records = input.records.map(({ source, external_id, entity_type }, index) => ({
      source,
      external_id,
      entity_type,
      data: raw.records[index]!.data,
    }));
    const result = await this.jobs.submit(request.principal!.tenantId, records, key);
    response.location(`/v1/jobs/${result.body.job_id}`);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }

  @Get('jobs/:jobId')
  @RequireScopes('jobs:read')
  @ApiParam({ name: 'jobId', format: 'uuid' })
  @ApiOkResponse({ type: BatchJobDto })
  get(
    @Req() request: AuthenticatedRequest,
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<BatchJobDto> {
    return this.jobs.get(request.principal!.tenantId, id);
  }
}
