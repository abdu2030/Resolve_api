import { Injectable } from '@nestjs/common';
import { EntityType, ResolutionDecision } from '@resolve/contracts';
import {
  DatabaseCanonicalSelectionRule,
  DatabaseCanonicalTriggerOperation,
  DatabaseEntityType,
  Prisma,
} from '@resolve/database';

import { acquireTransactionLock } from '../common/database/advisory-lock.js';
import { canonicalizeJson } from '../common/json/canonical-json.js';
import { CANONICALIZATION_VERSION } from './canonicalization.constants.js';
import { CanonicalizationDataIntegrityError } from './canonicalization-data-integrity.error.js';
import { buildCanonicalProjection } from './canonicalization-policy.js';
import type {
  CanonicalProjection,
  CanonicalTriggerOperation,
  CanonicalizationRecord,
} from './canonicalization.types.js';

export interface CanonicalizeLinkedEntityInput {
  tenantId: string;
  entityId: string;
  sourceRecordId: string;
  ingestionOperation: 'CREATED' | 'UPDATED' | 'UNCHANGED';
  resolutionDecision: ResolutionDecision.AutoMatch | ResolutionDecision.NoMatch;
}

export interface RecomputeAfterEntityOperationInput {
  tenantId: string;
  entityId: string;
  entityOperationId: string;
  operation: 'MERGE' | 'SPLIT';
}

export interface CanonicalizeAfterReviewInput {
  tenantId: string;
  entityId: string;
  sourceRecordId: string;
  reviewDecisionId: string;
  decision: 'APPROVE' | 'REJECT';
}

@Injectable()
export class CanonicalizationService {
  async canonicalizeLinkedEntity(
    transaction: Prisma.TransactionClient,
    input: CanonicalizeLinkedEntityInput,
  ): Promise<void> {
    await this.recompute(transaction, input);
  }

  async recomputeAfterEntityOperation(
    transaction: Prisma.TransactionClient,
    input: RecomputeAfterEntityOperationInput,
  ): Promise<void> {
    await this.recompute(transaction, input);
  }

  async canonicalizeAfterReview(
    transaction: Prisma.TransactionClient,
    input: CanonicalizeAfterReviewInput,
  ): Promise<void> {
    await this.recompute(transaction, input);
  }

  private async recompute(
    transaction: Prisma.TransactionClient,
    input:
      | CanonicalizeLinkedEntityInput
      | RecomputeAfterEntityOperationInput
      | CanonicalizeAfterReviewInput,
  ): Promise<void> {
    const structural = 'entityOperationId' in input;
    const reviewed = 'reviewDecisionId' in input;
    await acquireTransactionLock(
      transaction,
      `canonicalization:${input.tenantId}:${input.entityId}`,
    );

    const entity = await transaction.entity.findUnique({
      where: { tenantId_id: { tenantId: input.tenantId, id: input.entityId } },
      select: {
        entityType: true,
        canonicalData: true,
        canonicalVersion: true,
        canonicalVersions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { version: true, provenance: true },
        },
      },
    });
    if (!entity) throw new CanonicalizationDataIntegrityError();
    const currentHistory =
      entity.canonicalVersion > 0
        ? requireCurrentHistory(entity.canonicalVersion, entity.canonicalVersions[0])
        : null;
    if (
      !structural &&
      !reviewed &&
      input.ingestionOperation === 'UNCHANGED' &&
      entity.canonicalVersion > 0
    )
      return;

    const linkedRecords = await transaction.entityRecordLink.findMany({
      where: { tenantId: input.tenantId, entityId: input.entityId },
      select: {
        sourceRecord: {
          select: {
            id: true,
            externalId: true,
            rawPayload: true,
            normalizedPayload: true,
            normalizationVersion: true,
            updatedAt: true,
            sourceSystem: {
              select: { id: true, name: true, priority: true },
            },
          },
        },
      },
    });
    const records = linkedRecords.map(({ sourceRecord }) => canonicalizationRecord(sourceRecord));
    if (!structural && !records.some(({ id }) => id === input.sourceRecordId)) {
      throw new CanonicalizationDataIntegrityError();
    }

    const projection = buildCanonicalProjection(contractEntityType(entity.entityType), records);
    const persistedProjection = jsonProjection(projection);
    if (!structural && !reviewed && currentHistory) {
      if (
        canonicalizeJson({
          canonicalData: entity.canonicalData,
          provenance: currentHistory.provenance,
        }) === canonicalizeJson(persistedProjection)
      ) {
        return;
      }
    }

    const nextVersion = entity.canonicalVersion + 1;
    await transaction.entity.update({
      where: { tenantId_id: { tenantId: input.tenantId, id: input.entityId } },
      data: {
        canonicalData: persistedProjection.canonicalData,
        canonicalVersion: nextVersion,
      },
    });
    await transaction.entityFieldProvenance.deleteMany({
      where: { tenantId: input.tenantId, entityId: input.entityId },
    });
    if (projection.fields.length > 0) {
      await transaction.entityFieldProvenance.createMany({
        data: projection.fields.map((field) => ({
          tenantId: input.tenantId,
          entityId: input.entityId,
          fieldPath: field.fieldPath,
          canonicalValue: field.canonicalValue,
          rawValue: field.rawValue,
          sourceRecordId: field.sourceRecordId,
          sourceSystemId: field.sourceSystemId,
          sourceExternalId: field.externalId,
          sourcePriority: field.sourcePriority,
          selectionRule: DatabaseCanonicalSelectionRule[field.selectionRule],
          completenessScore: field.completenessScore,
          observedAt: field.observedAt,
          normalizationVersion: field.normalizationVersion,
          canonicalizationVersion: field.canonicalizationVersion,
        })),
      });
    }
    await transaction.entityCanonicalVersion.create({
      data: {
        tenantId: input.tenantId,
        entityId: input.entityId,
        version: nextVersion,
        canonicalData: persistedProjection.canonicalData,
        provenance: persistedProjection.provenance,
        triggerSourceRecordId: structural ? null : input.sourceRecordId,
        triggerOperation:
          DatabaseCanonicalTriggerOperation[
            structural
              ? input.operation
              : reviewed
                ? input.decision === 'APPROVE'
                  ? 'REVIEW_APPROVED'
                  : 'REVIEW_REJECTED'
                : triggerFor(input)
          ],
        entityOperationId: structural ? input.entityOperationId : null,
        reviewDecisionId: reviewed ? input.reviewDecisionId : null,
        canonicalizationVersion: CANONICALIZATION_VERSION,
      },
    });
  }
}

function requireCurrentHistory(
  canonicalVersion: number,
  latest: { version: number; provenance: Prisma.JsonValue } | undefined,
): { version: number; provenance: Prisma.JsonValue } {
  if (!latest || latest.version !== canonicalVersion) {
    throw new CanonicalizationDataIntegrityError();
  }
  return latest;
}

function triggerFor(input: CanonicalizeLinkedEntityInput): CanonicalTriggerOperation {
  if (input.ingestionOperation === 'UNCHANGED') return 'LEGACY_BACKFILL';
  if (input.ingestionOperation === 'UPDATED') return 'RECORD_UPDATED';
  return input.resolutionDecision === ResolutionDecision.NoMatch
    ? 'ENTITY_CREATED'
    : 'RECORD_LINKED';
}

function canonicalizationRecord(record: {
  id: string;
  externalId: string;
  updatedAt: Date;
  rawPayload: Prisma.JsonValue;
  normalizedPayload: Prisma.JsonValue | null;
  normalizationVersion: string | null;
  sourceSystem: { id: string; name: string; priority: number };
}): CanonicalizationRecord {
  const rawPayload = plainObject(record.rawPayload);
  const normalizedPayload = plainObject(record.normalizedPayload);
  if (!rawPayload || !normalizedPayload || !record.normalizationVersion) {
    throw new CanonicalizationDataIntegrityError();
  }
  return {
    id: record.id,
    externalId: record.externalId,
    updatedAt: record.updatedAt,
    rawPayload,
    normalizedPayload,
    normalizationVersion: record.normalizationVersion,
    source: record.sourceSystem,
  };
}

function plainObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function contractEntityType(entityType: DatabaseEntityType): EntityType {
  return entityType === DatabaseEntityType.PERSON ? EntityType.Person : EntityType.Company;
}

function jsonProjection(projection: CanonicalProjection): {
  canonicalData: Prisma.InputJsonObject;
  provenance: Prisma.InputJsonObject;
} {
  return {
    canonicalData: jsonObject(projection.canonicalData),
    provenance: jsonObject(projection.provenance),
  };
}

function jsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}
