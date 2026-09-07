import { ApiProperty } from '@nestjs/swagger';
import {
  EntityType,
  type IngestionOperation,
  type RecordIngestionResult,
} from '@resolve/contracts';

export class RecordResponseDto implements RecordIngestionResult {
  @ApiProperty({ format: 'uuid' }) record_id!: string;
  @ApiProperty({ format: 'uuid' }) source_id!: string;
  @ApiProperty() external_id!: string;
  @ApiProperty({ enum: EntityType }) entity_type!: EntityType;
  @ApiProperty({ minimum: 1 }) version!: number;
  @ApiProperty({ enum: ['STORED'] }) status!: 'STORED';
  @ApiProperty({ enum: ['CREATED', 'UPDATED', 'UNCHANGED'] }) operation!: IngestionOperation;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
  @ApiProperty({ format: 'date-time' }) updated_at!: string;
}

export interface RecordIngestionExecution {
  body: RecordIngestionResult;
  httpStatus: number;
  replayed: boolean;
}
