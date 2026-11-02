import { Inject, Injectable } from '@nestjs/common';
import type { ReviewListQueryDto } from '@resolve/contracts';
import type { ResolvePrismaClient } from '@resolve/database';
import { ApiException } from '../common/http/api-exception.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { decodeReviewCursor, encodeReviewCursor } from './review-cursor.js';
import { mapReview, mapReviewDecision } from './review.mapper.js';
import { approvalAvailable, reviewDetailsInclude } from './review-policy.js';
import type { ReviewDetailDto, ReviewPageDto } from './review-response.dto.js';

@Injectable()
export class ReviewQueryService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient) {}

  async list(tenantId: string, query: ReviewListQueryDto): Promise<ReviewPageDto> {
    const status = query.status ?? 'OPEN';
    const cursor = query.cursor === undefined ? null : decodeReviewCursor(query.cursor, status);
    const limit = query.limit ?? 25;
    const rows = await this.prisma.reviewCase.findMany({
      where: {
        tenantId,
        status,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(mapReview),
      next_cursor: rows.length > limit ? encodeReviewCursor(page[page.length - 1]!, status) : null,
    };
  }

  detail(tenantId: string, reviewId: string): Promise<ReviewDetailDto> {
    return this.prisma.$transaction(
      async (transaction) => {
        const row = await transaction.reviewCase.findUnique({
          where: { tenantId_id: { tenantId, id: reviewId } },
          include: reviewDetailsInclude,
        });
        if (!row) throw new ApiException(404, 'REVIEW_NOT_FOUND', 'Review case does not exist');
        const snapshots = await transaction.sourceRecordVersion.findMany({
          where: {
            tenantId,
            OR: [
              { sourceRecordId: row.sourceRecordId, version: row.sourceRecordVersion ?? 1 },
              {
                sourceRecordId: row.candidateSourceRecordId,
                version: row.candidateRecordVersion ?? 1,
              },
            ],
          },
          select: { sourceRecordId: true, rawPayload: true },
        });
        const record = (
          value: typeof row.sourceRecord,
          evidenceVersion: number | null,
        ): Record<string, unknown> => ({
          record_id: value.id,
          source_system_id: value.sourceSystemId,
          external_id: value.externalId,
          normalization_version: value.normalizationVersion,
          entity_type: value.entityType === 'PERSON' ? 'person' : 'company',
          current_version: value.currentVersion,
          evidence_version: evidenceVersion,
          raw_payload: value.rawPayload,
          normalized_payload: value.normalizedPayload,
          evidence_raw_payload:
            evidenceVersion === null
              ? null
              : (snapshots.find((snapshot) => snapshot.sourceRecordId === value.id)?.rawPayload ??
                null),
          current_entity_id: value.entityRecordLink?.entityId ?? null,
        });
        return {
          ...mapReview(row),
          source_record: record(row.sourceRecord, row.sourceRecordVersion),
          candidate_record: record(row.candidateSourceRecord, row.candidateRecordVersion),
          candidate_entity: {
            entity_id: row.candidateEntityId,
            status: row.candidateEntity.status,
            merged_into_entity_id: row.candidateEntity.mergedIntoEntityId,
            canonical_version: row.candidateEntity.canonicalVersion,
            canonical_data: row.candidateEntity.canonicalData,
          },
          evidence: {
            match_feature_id: row.matchFeatureId,
            feature_version: row.matchFeature.featureVersion,
            score_inputs: row.matchFeature.scoreInputs,
            scoring_explanation: row.matchFeature.explanation,
            explanation: row.explanation,
            algorithm_version: row.algorithmVersion,
            confidence: Number(row.score),
          },
          approval_available: approvalAvailable(row),
          human_decision: row.humanDecision ? mapReviewDecision(row.humanDecision) : null,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
