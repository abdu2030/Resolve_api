import { ApiProperty } from '@nestjs/swagger';
import { ENTITY_OPERATIONS_VERSION, type EntityOperationResult } from '@resolve/contracts';

export class EntityOperationResponseDto implements EntityOperationResult {
  @ApiProperty({ format: 'uuid' }) operation_id!: string;
  @ApiProperty({ enum: ['MERGE', 'SPLIT', 'UNMERGE'] }) operation!: 'MERGE' | 'SPLIT' | 'UNMERGE';
  @ApiProperty({ enum: [ENTITY_OPERATIONS_VERSION] })
  operation_version!: typeof ENTITY_OPERATIONS_VERSION;
  @ApiProperty({ format: 'uuid' }) source_entity_id!: string;
  @ApiProperty({ format: 'uuid' }) target_entity_id!: string;
  @ApiProperty({ type: [String], format: 'uuid', minItems: 1, maxItems: 1000 })
  record_ids!: string[];
  @ApiProperty({ minLength: 1, maxLength: 500 }) reason!: string;
  @ApiProperty({ format: 'uuid' }) actor_api_key_id!: string;
  @ApiProperty({ minimum: 0 }) source_version_before!: number;
  @ApiProperty({ minimum: 0 }) source_version_after!: number;
  @ApiProperty({ minimum: 0 }) target_version_before!: number;
  @ApiProperty({ minimum: 0 }) target_version_after!: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) reversed_operation_id!:
    string | null;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
}
