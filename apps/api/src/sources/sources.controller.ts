import { Body, Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CreateSourceDto } from '@resolve/contracts';
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../auth/auth-principal.js';
import { RequireScopes } from '../auth/require-scopes.decorator.js';
import { API_ERROR_SCHEMA } from '../common/http/api-error-schema.js';
import { SourceRegistrationService } from './source-registration.service.js';
import { SourceResponseDto } from './source-response.dto.js';

@ApiTags('sources')
@ApiBearerAuth('api-key')
@Controller('sources')
export class SourcesController {
  constructor(private readonly registration: SourceRegistrationService) {}

  @Post()
  @RequireScopes('sources:write')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'type'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', maxLength: 120, example: 'crm' },
        type: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', maxLength: 50, example: 'api' },
      },
    },
  })
  @ApiCreatedResponse({ type: SourceResponseDto })
  @ApiOkResponse({ type: SourceResponseDto })
  @ApiUnauthorizedResponse({ schema: API_ERROR_SCHEMA })
  @ApiForbiddenResponse({ schema: API_ERROR_SCHEMA })
  @ApiConflictResponse({ schema: API_ERROR_SCHEMA })
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() input: CreateSourceDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SourceResponseDto> {
    const result = await this.registration.register(request.principal!.tenantId, input);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.body;
  }
}
