import { Inject, Injectable } from '@nestjs/common';
import {
  REVIEW_POLICY_VERSION,
  type ReviewDecisionDto,
  type ReviewDecisionResult,
} from '@resolve/contracts';
import { Prisma, type ResolvePrismaClient } from '@resolve/database';
import type { AuthPrincipal } from '../auth/auth-principal.js';
import { CanonicalizationService } from '../canonicalization/canonicalization.service.js';
import { acquireTransactionLock } from '../common/database/advisory-lock.js';
import { acquireEntityMembershipLock } from '../common/database/entity-membership-lock.js';
import { ApiException } from '../common/http/api-exception.js';
import { hashCanonicalJson } from '../common/json/canonical-json.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { mapReviewDecision } from './review.mapper.js';
import { assertApproval, assertReviewOpen, reviewDetailsInclude } from './review-policy.js';

export interface ReviewDecisionExecution {
  body: ReviewDecisionResult;
  replayed: boolean;
}

@Injectable()
export class ReviewDecisionService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient,
    private readonly canonicalization: CanonicalizationService,
  ) {}

  decide(
    principal: AuthPrincipal,
    reviewId: string,
    input: ReviewDecisionDto,
    key: string,
  ): Promise<ReviewDecisionExecution> {
    const { tenantId } = principal;
    const id = reviewId.toLowerCase();
    const reason = input.reason.trim();
    const operation = `POST /v1/reviews/${id}/decision`;
    const requestHash = hashCanonicalJson({
      operation,
      decision: input.decision,
      reason,
      expected_source_version: input.expected_source_version,
      expected_candidate_version: input.expected_candidate_version,
    });
    return this.prisma.$transaction(async (transaction) => {
      await acquireTransactionLock(transaction, `idempotency:${tenantId}:${key}`);
      const replay = await transaction.idempotencyRequest.findUnique({
        where: { tenantId_key: { tenantId, key } },
      });
      if (replay) {
        if (replay.operation !== operation || replay.requestHash !== requestHash)
          throw new ApiException(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used for a different request',
          );
        return { body: replay.responseBody as unknown as ReviewDecisionResult, replayed: true };
      }
      await acquireEntityMembershipLock(transaction, tenantId, 'exclusive');
      const row = await transaction.reviewCase.findUnique({
        where: { tenantId_id: { tenantId, id } },
        include: reviewDetailsInclude,
      });
      if (!row) throw new ApiException(404, 'REVIEW_NOT_FOUND', 'Review case does not exist');
      const actor = await transaction.apiKey.findUnique({
        where: { tenantId_id: { tenantId, id: principal.apiKeyId } },
        select: { id: true },
      });
      if (!actor) throw new ApiException(404, 'REVIEW_NOT_FOUND', 'Review case does not exist');
      assertReviewOpen(row, input.expected_source_version);
      const approved = input.decision === 'APPROVE';
      if (approved) assertApproval(row, input.expected_candidate_version);
      const entity = approved
        ? row.candidateEntity
        : await transaction.entity.create({
            data: { tenantId, entityType: row.sourceRecord.entityType },
          });
      const decision = await transaction.reviewDecision.create({
        data: {
          tenantId,
          reviewCaseId: id,
          decision: input.decision,
          reason,
          actorApiKeyId: principal.apiKeyId,
          entityId: entity.id,
          sourceRecordVersion: row.sourceRecord.currentVersion,
          candidateRecordVersion: row.candidateSourceRecord.currentVersion,
          candidateCanonicalVersion: row.candidateEntity.canonicalVersion,
          canonicalVersion: entity.canonicalVersion + 1,
          policyVersion: REVIEW_POLICY_VERSION,
        },
      });
      await transaction.entityRecordLink.create({
        data: {
          tenantId,
          entityId: entity.id,
          sourceRecordId: row.sourceRecordId,
          score: row.score,
          decision: 'REVIEW',
          algorithmVersion: row.algorithmVersion,
          explanation: row.explanation as Prisma.InputJsonValue,
          reviewDecisionId: decision.id,
        },
      });
      const closed = await transaction.reviewCase.updateMany({
        where: { tenantId, id, status: 'OPEN' },
        data: { status: 'RESOLVED' },
      });
      if (closed.count !== 1)
        throw new ApiException(409, 'REVIEW_ALREADY_RESOLVED', 'Review case is already resolved');
      await this.canonicalization.canonicalizeAfterReview(transaction, {
        tenantId,
        entityId: entity.id,
        sourceRecordId: row.sourceRecordId,
        reviewDecisionId: decision.id,
        decision: input.decision,
      });
      const body = mapReviewDecision(decision);
      await transaction.idempotencyRequest.create({
        data: {
          tenantId,
          key,
          operation,
          requestHash,
          responseStatus: 200,
          responseBody: body as unknown as Prisma.InputJsonObject,
        },
      });
      return { body, replayed: false };
    });
  }
}
