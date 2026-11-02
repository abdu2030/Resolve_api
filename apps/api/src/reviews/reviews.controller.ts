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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ReviewDecisionDto, ReviewListQueryDto } from '@resolve/contracts';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth-principal.js';
import { RequireScopes } from '../auth/require-scopes.decorator.js';
import { API_ERROR_SCHEMA } from '../common/http/api-error-schema.js';
import { ApiException } from '../common/http/api-exception.js';
import { validateIdempotencyKey } from '../records/idempotency-key.js';
import { ReviewDecisionService } from './review-decision.service.js';
import { ReviewQueryService } from './review-query.service.js';
import {
  ReviewDecisionResponseDto,
  ReviewDetailDto,
  ReviewPageDto,
} from './review-response.dto.js';

@ApiTags('reviews')
@ApiBearerAuth('api-key')
@ApiUnauthorizedResponse({ schema: API_ERROR_SCHEMA })
@ApiForbiddenResponse({ schema: API_ERROR_SCHEMA })
@ApiBadRequestResponse({ schema: API_ERROR_SCHEMA })
@ApiInternalServerErrorResponse({ schema: API_ERROR_SCHEMA })
@Controller('reviews')
export class ReviewsController {
  constructor(
    private readonly queries: ReviewQueryService,
    private readonly decisions: ReviewDecisionService,
  ) {}

  @Get()
  @RequireScopes('reviews:read')
  @ApiQuery({ name: 'status', required: false, enum: ['OPEN', 'RESOLVED'] })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiOkResponse({ type: ReviewPageDto })
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ReviewListQueryDto,
  ): Promise<ReviewPageDto> {
    return this.queries.list(request.principal!.tenantId, query);
  }

  @Get(':reviewId')
  @RequireScopes('reviews:read')
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiOkResponse({ type: ReviewDetailDto })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  detail(
    @Req() request: AuthenticatedRequest,
    @Param('reviewId', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ReviewDetailDto> {
    return this.queries.detail(request.principal!.tenantId, id.toLowerCase());
  }

  @Post(':reviewId/decision')
  @HttpCode(200)
  @RequireScopes('reviews:write')
  @ApiParam({ name: 'reviewId', format: 'uuid' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '1-255 visible ASCII characters without whitespace',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['decision', 'reason', 'expected_source_version', 'expected_candidate_version'],
      properties: {
        decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
        expected_source_version: { type: 'integer', minimum: 1, maximum: 2147483647 },
        expected_candidate_version: { type: 'integer', minimum: 0, maximum: 2147483647 },
      },
    },
  })
  @ApiOkResponse({
    type: ReviewDecisionResponseDto,
    headers: { 'Idempotency-Replayed': { schema: { type: 'string', enum: ['true'] } } },
  })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  @ApiConflictResponse({ schema: API_ERROR_SCHEMA })
  async decide(
    @Req() request: AuthenticatedRequest,
    @Param('reviewId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: ReviewDecisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReviewDecisionResponseDto> {
    const validated = validateIdempotencyKey(key);
    if (validated === undefined)
      throw new ApiException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
    const result = await this.decisions.decide(request.principal!, id, input, validated);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }
}
