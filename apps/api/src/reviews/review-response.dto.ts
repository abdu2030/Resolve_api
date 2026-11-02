import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  REVIEW_POLICY_VERSION,
  type ReviewDecisionResult,
  type ReviewOutcome,
} from '@resolve/contracts';

export class ReviewDecisionResponseDto implements ReviewDecisionResult {
  @ApiProperty({ format: 'uuid' }) review_decision_id!: string;
  @ApiProperty({ format: 'uuid' }) review_id!: string;
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] }) decision!: ReviewOutcome;
  @ApiProperty({ maxLength: 500 }) reason!: string;
  @ApiProperty({ format: 'uuid' }) actor_api_key_id!: string;
  @ApiProperty({ format: 'uuid' }) entity_id!: string;
  @ApiProperty({ minimum: 1 }) source_record_version!: number;
  @ApiProperty({ minimum: 1 }) candidate_record_version!: number;
  @ApiProperty({ minimum: 0 }) candidate_canonical_version!: number;
  @ApiProperty({ minimum: 1 }) canonical_version!: number;
  @ApiProperty({ enum: [REVIEW_POLICY_VERSION] }) policy_version!: typeof REVIEW_POLICY_VERSION;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
}

export class ReviewSummaryDto {
  @ApiProperty({ format: 'uuid' }) review_id!: string;
  @ApiProperty({ enum: ['OPEN', 'RESOLVED'] }) status!: 'OPEN' | 'RESOLVED';
  @ApiProperty({ format: 'uuid' }) source_record_id!: string;
  @ApiProperty({ format: 'uuid' }) candidate_entity_id!: string;
  @ApiProperty({ format: 'uuid' }) candidate_record_id!: string;
  @ApiProperty({ minimum: 0, maximum: 1 }) confidence!: number;
  @ApiProperty() algorithm_version!: string;
  @ApiProperty({ type: Number, nullable: true }) source_record_version!: number | null;
  @ApiProperty({ type: Number, nullable: true }) candidate_record_version!: number | null;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
}

export class ReviewPageDto {
  @ApiProperty({ type: [ReviewSummaryDto] }) items!: ReviewSummaryDto[];
  @ApiPropertyOptional({ type: String, nullable: true }) next_cursor!: string | null;
}

export class ReviewDetailDto extends ReviewSummaryDto {
  @ApiProperty({
    description: 'Original immutable machine evidence',
    type: 'object',
    additionalProperties: true,
  })
  evidence!: Record<string, unknown>;
  @ApiProperty({
    description: 'Current data and the raw payload used for evidence, if available',
    type: 'object',
    additionalProperties: true,
  })
  source_record!: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true }) candidate_record!: Record<
    string,
    unknown
  >;
  @ApiProperty({ type: 'object', additionalProperties: true }) candidate_entity!: Record<
    string,
    unknown
  >;
  @ApiProperty() approval_available!: boolean;
  @ApiProperty({ type: ReviewDecisionResponseDto, nullable: true })
  human_decision!: ReviewDecisionResponseDto | null;
}
