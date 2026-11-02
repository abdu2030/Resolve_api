import { REVIEW_POLICY_VERSION, type ReviewDecisionResult } from '@resolve/contracts';
import type { Prisma } from '@resolve/database';
import type { ReviewSummaryDto } from './review-response.dto.js';

export function mapReviewDecision(
  row: Prisma.ReviewDecisionGetPayload<Record<string, never>>,
): ReviewDecisionResult {
  if (row.policyVersion !== REVIEW_POLICY_VERSION)
    throw new Error('Unsupported stored review policy');
  return {
    review_decision_id: row.id,
    review_id: row.reviewCaseId,
    decision: row.decision,
    reason: row.reason,
    actor_api_key_id: row.actorApiKeyId,
    entity_id: row.entityId,
    source_record_version: row.sourceRecordVersion,
    candidate_record_version: row.candidateRecordVersion,
    candidate_canonical_version: row.candidateCanonicalVersion,
    canonical_version: row.canonicalVersion,
    policy_version: REVIEW_POLICY_VERSION,
    created_at: row.createdAt.toISOString(),
  };
}

export function mapReview(
  row: Prisma.ReviewCaseGetPayload<Record<string, never>>,
): ReviewSummaryDto {
  return {
    review_id: row.id,
    status: row.status,
    source_record_id: row.sourceRecordId,
    candidate_entity_id: row.candidateEntityId,
    candidate_record_id: row.candidateSourceRecordId,
    confidence: Number(row.score),
    algorithm_version: row.algorithmVersion,
    source_record_version: row.sourceRecordVersion,
    candidate_record_version: row.candidateRecordVersion,
    created_at: row.createdAt.toISOString(),
  };
}
