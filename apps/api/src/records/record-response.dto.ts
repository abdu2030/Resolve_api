import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EntityType,
  ResolutionDecision,
  type ContradictionEvidence,
  type IngestionOperation,
  type RecordIngestionResult,
  type ResolutionExplanation,
} from '@resolve/contracts';

class ResolutionContradictionDto implements ContradictionEvidence {
  @ApiProperty() code!: string;
  @ApiPropertyOptional() field?: string;
  @ApiProperty() message!: string;
  @ApiProperty({ enum: ['blocking', 'warning'] }) severity!: 'blocking' | 'warning';
}

class ResolutionExplanationDto implements ResolutionExplanation {
  @ApiProperty({ minimum: 0 }) candidate_count!: number;
  @ApiProperty({ type: [ResolutionContradictionDto] })
  contradictions!: ResolutionContradictionDto[];
  @ApiProperty({ type: 'object', additionalProperties: true })
  features!: Record<string, boolean | null | number | string>;
}

export class RecordResponseDto implements RecordIngestionResult {
  @ApiProperty({ format: 'uuid' }) record_id!: string;
  @ApiProperty({ format: 'uuid' }) source_id!: string;
  @ApiProperty() external_id!: string;
  @ApiProperty({ enum: EntityType }) entity_type!: EntityType;
  @ApiProperty({ minimum: 1 }) version!: number;
  @ApiProperty({ enum: ['STORED'] }) status!: 'STORED';
  @ApiProperty({ enum: ['CREATED', 'UPDATED', 'UNCHANGED'] }) operation!: IngestionOperation;
  @ApiProperty({ format: 'uuid' }) entity_id!: string;
  @ApiProperty({ enum: ResolutionDecision }) decision!: ResolutionDecision;
  @ApiProperty({ minimum: 0, maximum: 1 }) confidence!: number;
  @ApiPropertyOptional({ format: 'uuid' }) matched_against?: string;
  @ApiProperty({ type: ResolutionExplanationDto })
  explanation!: ResolutionExplanation;
  @ApiProperty() algorithm_version!: string;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
  @ApiProperty({ format: 'date-time' }) updated_at!: string;
}

export interface RecordIngestionExecution {
  body: RecordIngestionResult;
  httpStatus: number;
  replayed: boolean;
}
