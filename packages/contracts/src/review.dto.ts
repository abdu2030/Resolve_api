import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

export const REVIEW_POLICY_VERSION = 'review-v1';
export const REVIEW_OUTCOMES = ['APPROVE', 'REJECT'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export class ReviewDecisionDto {
  @IsIn(REVIEW_OUTCOMES)
  decision!: ReviewOutcome;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  expected_source_version!: number;

  @IsInt()
  @Min(0)
  @Max(2147483647)
  expected_candidate_version!: number;
}

export class ReviewListQueryDto {
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsIn(['OPEN', 'RESOLVED'])
  status?: 'OPEN' | 'RESOLVED';

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  cursor?: string;
}

export interface ReviewDecisionResult {
  review_decision_id: string;
  review_id: string;
  decision: ReviewOutcome;
  reason: string;
  actor_api_key_id: string;
  entity_id: string;
  source_record_version: number;
  candidate_record_version: number;
  candidate_canonical_version: number;
  canonical_version: number;
  policy_version: typeof REVIEW_POLICY_VERSION;
  created_at: string;
}
