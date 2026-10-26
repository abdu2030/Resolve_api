import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { AuthenticatedRequest } from '../auth/auth-principal.js';
import { RequireScopes } from '../auth/require-scopes.decorator.js';
import { API_ERROR_SCHEMA } from '../common/http/api-error-schema.js';
import { EntityPageQueryDto } from './entity-pagination.dto.js';
import { EntityQueryService } from './entity-query.service.js';
import {
  EntityHistoryPageDto,
  EntityResponseDto,
  LinkedRecordPageDto,
} from './entity-response.dto.js';

@ApiTags('entities')
@ApiBearerAuth('api-key')
@Controller('entities')
export class EntitiesController {
  constructor(private readonly entities: EntityQueryService) {}

  @Get(':entityId/records')
  @RequireScopes('entities:read')
  @ApiParam({ name: 'entityId', format: 'uuid' })
  @ApiOkResponse({ type: LinkedRecordPageDto })
  @ApiBadRequestResponse({ schema: API_ERROR_SCHEMA })
  @ApiUnauthorizedResponse({ schema: API_ERROR_SCHEMA })
  @ApiForbiddenResponse({ schema: API_ERROR_SCHEMA })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  listRecords(
    @Req() request: AuthenticatedRequest,
    @Param('entityId', new ParseUUIDPipe({ version: '4' })) entityId: string,
    @Query() query: EntityPageQueryDto,
  ): Promise<LinkedRecordPageDto> {
    return this.entities.listRecords(request.principal!.tenantId, entityId, query);
  }

  @Get(':entityId/history')
  @RequireScopes('entities:read')
  @ApiParam({ name: 'entityId', format: 'uuid' })
  @ApiOkResponse({ type: EntityHistoryPageDto })
  @ApiBadRequestResponse({ schema: API_ERROR_SCHEMA })
  @ApiUnauthorizedResponse({ schema: API_ERROR_SCHEMA })
  @ApiForbiddenResponse({ schema: API_ERROR_SCHEMA })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  listHistory(
    @Req() request: AuthenticatedRequest,
    @Param('entityId', new ParseUUIDPipe({ version: '4' })) entityId: string,
    @Query() query: EntityPageQueryDto,
  ): Promise<EntityHistoryPageDto> {
    return this.entities.listHistory(request.principal!.tenantId, entityId, query);
  }

  @Get(':entityId')
  @RequireScopes('entities:read')
  @ApiParam({ name: 'entityId', format: 'uuid' })
  @ApiOkResponse({ type: EntityResponseDto })
  @ApiBadRequestResponse({ schema: API_ERROR_SCHEMA })
  @ApiUnauthorizedResponse({ schema: API_ERROR_SCHEMA })
  @ApiForbiddenResponse({ schema: API_ERROR_SCHEMA })
  @ApiNotFoundResponse({ schema: API_ERROR_SCHEMA })
  get(
    @Req() request: AuthenticatedRequest,
    @Param('entityId', new ParseUUIDPipe({ version: '4' })) entityId: string,
  ): Promise<EntityResponseDto> {
    return this.entities.getEntity(request.principal!.tenantId, entityId);
  }
}
