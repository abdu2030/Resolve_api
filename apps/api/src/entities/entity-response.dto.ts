import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityType, ResolutionDecision } from '@resolve/contracts';

import { EntityOperationResponseDto } from './entity-operation-response.dto.js';

class LinkedRecordSourceDto {
  @ApiProperty({ format: 'uuid' }) source_system_id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ minimum: 0, maximum: 1000 }) priority!: number;
}

class LinkedRecordLinkDto {
  @ApiProperty({ enum: ResolutionDecision }) decision!: ResolutionDecision;
  @ApiProperty({ minimum: 0, maximum: 1 }) confidence!: number;
  @ApiProperty() algorithm_version!: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  explanation!: Record<string, unknown>;
  @ApiProperty({ format: 'date-time' }) linked_at!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) entity_operation_id!:
    string | null;
}

export class LinkedRecordResponseDto {
  @ApiProperty({ format: 'uuid' }) record_id!: string;
  @ApiProperty({ enum: EntityType }) entity_type!: EntityType;
  @ApiProperty() external_id!: string;
  @ApiProperty({ type: LinkedRecordSourceDto }) source!: LinkedRecordSourceDto;
  @ApiProperty({ type: 'object', additionalProperties: true })
  raw_payload!: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true })
  normalized_payload!: Record<string, unknown>;
  @ApiProperty() normalization_version!: string;
  @ApiProperty({ format: 'date-time' }) record_created_at!: string;
  @ApiProperty({ format: 'date-time' }) record_updated_at!: string;
  @ApiProperty({ type: LinkedRecordLinkDto }) link!: LinkedRecordLinkDto;
}

export class LinkedRecordPageDto {
  @ApiProperty({ type: [LinkedRecordResponseDto] }) items!: LinkedRecordResponseDto[];
  @ApiPropertyOptional({ nullable: true, type: String }) next_cursor!: string | null;
}

class EntityHistoryTriggerDto {
  @ApiProperty({
    enum: [
      'ENTITY_CREATED',
      'RECORD_LINKED',
      'RECORD_UPDATED',
      'LEGACY_BACKFILL',
      'MERGE',
      'SPLIT',
    ],
  })
  operation!:
    'ENTITY_CREATED' | 'RECORD_LINKED' | 'RECORD_UPDATED' | 'LEGACY_BACKFILL' | 'MERGE' | 'SPLIT';

  @ApiPropertyOptional({ format: 'uuid', nullable: true, type: String })
  source_record_id!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) entity_operation_id!:
    string | null;
}

export class EntityHistoryResponseDto {
  @ApiProperty({ minimum: 1 }) version!: number;
  @ApiProperty({ type: 'object', additionalProperties: true })
  canonical_data!: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true })
  provenance!: Record<string, unknown>;
  @ApiProperty({ type: EntityHistoryTriggerDto }) trigger!: EntityHistoryTriggerDto;
  @ApiProperty({ type: EntityOperationResponseDto, nullable: true })
  entity_operation!: EntityOperationResponseDto | null;
  @ApiProperty() canonicalization_version!: string;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
}

export class EntityHistoryPageDto {
  @ApiProperty({ type: [EntityHistoryResponseDto] }) items!: EntityHistoryResponseDto[];
  @ApiPropertyOptional({ nullable: true, type: String }) next_cursor!: string | null;
}

export class EntityResponseDto {
  @ApiProperty({ format: 'uuid' }) entity_id!: string;
  @ApiProperty({ enum: EntityType }) entity_type!: EntityType;
  @ApiProperty({ enum: ['ACTIVE', 'MERGED'] }) status!: 'ACTIVE' | 'MERGED';
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) merged_into_entity_id!:
    string | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  canonical_data!: Record<string, unknown>;
  @ApiProperty({ minimum: 0 }) canonical_version!: number;
  @ApiPropertyOptional({ nullable: true, type: String })
  canonicalization_version!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  provenance!: Record<string, unknown>;
  @ApiProperty({ minimum: 0 }) record_count!: number;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
  @ApiProperty({ format: 'date-time' }) updated_at!: string;
}
