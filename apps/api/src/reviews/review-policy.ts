import type { Prisma } from '@resolve/database';
import { ApiException } from '../common/http/api-exception.js';

export const reviewDetailsInclude = {
  sourceRecord: { include: { entityRecordLink: true } },
  candidateSourceRecord: { include: { entityRecordLink: true } },
  candidateEntity: true,
  matchFeature: true,
  humanDecision: true,
} satisfies Prisma.ReviewCaseInclude;
export type LoadedReview = Prisma.ReviewCaseGetPayload<{ include: typeof reviewDetailsInclude }>;

export function approvalAvailable(review: LoadedReview): boolean {
  return (
    review.status === 'OPEN' &&
    !review.sourceRecord.entityRecordLink &&
    review.candidateEntity.status === 'ACTIVE' &&
    review.sourceRecord.entityType === review.candidateEntity.entityType &&
    review.candidateSourceRecord.entityType === review.sourceRecord.entityType &&
    review.candidateSourceRecord.entityRecordLink?.entityId === review.candidateEntityId &&
    review.sourceRecord.currentVersion === (review.sourceRecordVersion ?? 1) &&
    review.candidateSourceRecord.currentVersion === (review.candidateRecordVersion ?? 1)
  );
}

export function assertReviewOpen(review: LoadedReview, expectedSourceVersion: number): void {
  if (review.status !== 'OPEN' || review.humanDecision)
    throw new ApiException(409, 'REVIEW_ALREADY_RESOLVED', 'Review case is already resolved');
  if (review.sourceRecord.entityRecordLink)
    throw new ApiException(409, 'REVIEW_RECORD_ALREADY_LINKED', 'Review record is already linked');
  if (review.sourceRecord.currentVersion !== expectedSourceVersion)
    throw new ApiException(
      409,
      'REVIEW_SOURCE_VERSION_CONFLICT',
      'Source record changed; inspect the case again',
    );
}

export function assertApproval(review: LoadedReview, expectedCandidateVersion: number): void {
  if (!approvalAvailable(review))
    throw new ApiException(
      409,
      'REVIEW_EVIDENCE_STALE',
      'Candidate or evidence changed; approval is unsafe',
    );
  if (review.candidateEntity.canonicalVersion !== expectedCandidateVersion)
    throw new ApiException(
      409,
      'ENTITY_VERSION_CONFLICT',
      'Candidate changed; inspect the case again',
    );
  if (review.candidateEntity.canonicalVersion === 2147483647)
    throw new ApiException(409, 'ENTITY_VERSION_CONFLICT', 'Canonical version limit reached');
}
