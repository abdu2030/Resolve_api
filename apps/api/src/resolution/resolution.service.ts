import { Injectable } from '@nestjs/common';
import {
  EntityType,
  MATCHING_POLICY,
  ResolutionDecision,
  type ResolutionExplanation,
} from '@resolve/contracts';
import { DatabaseEntityType, DatabaseMatchDecision, Prisma } from '@resolve/database';
import { extractFeatures, scoreFeatures, type ComparisonRecord } from '@resolve/matching';

import { CandidateGenerationService } from '../blocking/candidate-generation.service.js';
import type { BlockingCandidate } from '../blocking/blocking.types.js';
import { selectResolutionOutcome } from './candidate-selection.js';
import { ResolutionDataIntegrityError } from './resolution-data-integrity.error.js';
import type { CandidateScore, ResolutionExecution } from './resolution.types.js';

interface LoadedComparisonRecord extends ComparisonRecord {
  id: string;
}

@Injectable()
export class ResolutionService {
  constructor(private readonly candidates: CandidateGenerationService) {}

  async resolve(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    sourceRecordId: string,
  ): Promise<ResolutionExecution> {
    const storedLink = await transaction.entityRecordLink.findUnique({
      where: { tenantId_sourceRecordId: { tenantId, sourceRecordId } },
      select: {
        entityId: true,
        score: true,
        decision: true,
        algorithmVersion: true,
        explanation: true,
      },
    });
    if (storedLink) {
      const decision = contractDecision(storedLink.decision);
      return {
        entity_id: storedLink.entityId,
        decision,
        confidence: Number(storedLink.score),
        explanation: storedExplanation(storedLink.explanation),
        algorithm_version: storedLink.algorithmVersion,
        ...(decision === ResolutionDecision.AutoMatch
          ? { matched_against: storedLink.entityId }
          : {}),
      };
    }

    const storedReview = await transaction.reviewCase.findUnique({
      where: { tenantId_sourceRecordId: { tenantId, sourceRecordId } },
      select: {
        candidateEntityId: true,
        score: true,
        explanation: true,
        algorithmVersion: true,
      },
    });
    if (storedReview) {
      return {
        entity_id: storedReview.candidateEntityId,
        decision: ResolutionDecision.Review,
        confidence: Number(storedReview.score),
        explanation: storedExplanation(storedReview.explanation),
        algorithm_version: storedReview.algorithmVersion,
        matched_against: storedReview.candidateEntityId,
      };
    }

    const incoming = await loadComparisonRecord(transaction, tenantId, sourceRecordId);
    const blocking = await this.candidates.findCandidates(tenantId, sourceRecordId, transaction);
    const comparisons = await compareAndPersist(
      transaction,
      tenantId,
      incoming,
      blocking.candidates,
    );
    const selection = selectResolutionOutcome(comparisons);
    const explanation: ResolutionExplanation = {
      candidate_count: selection.candidateCount,
      features: selection.selected?.features ?? {},
      contradictions: [
        ...(selection.selected?.contradictions ?? []),
        ...selection.additionalContradictions,
      ],
    };
    const confidence = roundForPersistence(selection.selected?.score ?? 0);

    if (selection.decision === ResolutionDecision.AutoMatch) {
      const selected = requireSelected(selection.selected);
      await transaction.entityRecordLink.create({
        data: {
          tenantId,
          entityId: selected.entityId,
          sourceRecordId,
          score: confidence,
          decision: DatabaseMatchDecision.AUTO_MATCH,
          algorithmVersion: MATCHING_POLICY.version,
          explanation: explanation as unknown as Prisma.InputJsonObject,
        },
      });
      return {
        entity_id: selected.entityId,
        decision: ResolutionDecision.AutoMatch,
        confidence,
        explanation,
        algorithm_version: MATCHING_POLICY.version,
        matched_against: selected.entityId,
      };
    }

    if (selection.decision === ResolutionDecision.Review) {
      const selected = requireSelected(selection.selected);
      await transaction.reviewCase.create({
        data: {
          tenantId,
          sourceRecordId,
          candidateEntityId: selected.entityId,
          candidateSourceRecordId: selected.supportingRecordId,
          matchFeatureId: selected.matchFeatureId,
          score: confidence,
          explanation: explanation as unknown as Prisma.InputJsonObject,
          algorithmVersion: MATCHING_POLICY.version,
        },
      });
      return {
        entity_id: selected.entityId,
        decision: ResolutionDecision.Review,
        confidence,
        explanation,
        algorithm_version: MATCHING_POLICY.version,
        matched_against: selected.entityId,
      };
    }

    const entity = await transaction.entity.create({
      data: {
        tenantId,
        entityType: databaseEntityType(incoming.entityType),
      },
      select: { id: true },
    });
    await transaction.entityRecordLink.create({
      data: {
        tenantId,
        entityId: entity.id,
        sourceRecordId,
        score: confidence,
        decision: DatabaseMatchDecision.NO_MATCH,
        algorithmVersion: MATCHING_POLICY.version,
        explanation: explanation as unknown as Prisma.InputJsonObject,
      },
    });
    return {
      entity_id: entity.id,
      decision: ResolutionDecision.NoMatch,
      confidence,
      explanation,
      algorithm_version: MATCHING_POLICY.version,
    };
  }
}

async function compareAndPersist(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  incoming: LoadedComparisonRecord,
  candidates: BlockingCandidate[],
): Promise<CandidateScore[]> {
  const supportingIds = [
    ...new Set(candidates.flatMap(({ supportingRecordIds }) => supportingRecordIds)),
  ];
  if (supportingIds.length === 0) return [];

  const storedRecords = await transaction.sourceRecord.findMany({
    where: { tenantId, id: { in: supportingIds } },
    select: {
      id: true,
      entityType: true,
      rawPayload: true,
      normalizedPayload: true,
    },
  });
  if (storedRecords.length !== supportingIds.length) {
    throw new ResolutionDataIntegrityError();
  }
  const supportingById = new Map(
    storedRecords.map((record) => [record.id, comparisonRecord(record)]),
  );
  const scores: CandidateScore[] = [];

  for (const candidate of candidates) {
    for (const supportingRecordId of candidate.supportingRecordIds) {
      const supporting = supportingById.get(supportingRecordId);
      if (!supporting) throw new ResolutionDataIntegrityError();
      const extracted = extractFeatures(incoming, supporting);
      const scored = scoreFeatures(extracted);
      const confidence = roundForPersistence(scored.score);
      const evidence = await transaction.matchFeature.create({
        data: {
          tenantId,
          sourceRecordId: incoming.id,
          candidateSourceRecordId: supportingRecordId,
          candidateEntityId: candidate.entityId,
          featureVersion: extracted.featureVersion,
          algorithmVersion: scored.algorithmVersion,
          scoreInputs: scored.inputs as unknown as Prisma.InputJsonObject,
          explanation: scored.explanation as unknown as Prisma.InputJsonObject,
          score: confidence,
          decision: databaseDecision(scored.decision),
        },
        select: { id: true },
      });
      scores.push({
        entityId: candidate.entityId,
        supportingRecordId,
        matchFeatureId: evidence.id,
        score: scored.score,
        decision: scored.decision,
        features: { ...scored.inputs.features },
        contradictions: scored.inputs.contradictions.map((item) => ({ ...item })),
      });
    }
  }

  return scores;
}

async function loadComparisonRecord(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  sourceRecordId: string,
): Promise<LoadedComparisonRecord> {
  const record = await transaction.sourceRecord.findUnique({
    where: { tenantId_id: { tenantId, id: sourceRecordId } },
    select: {
      id: true,
      entityType: true,
      rawPayload: true,
      normalizedPayload: true,
    },
  });
  if (!record) throw new ResolutionDataIntegrityError();
  return comparisonRecord(record);
}

function comparisonRecord(record: {
  id: string;
  entityType: DatabaseEntityType;
  rawPayload: Prisma.JsonValue;
  normalizedPayload: Prisma.JsonValue | null;
}): LoadedComparisonRecord {
  const rawPayload = plainObject(record.rawPayload);
  const normalizedPayload = plainObject(record.normalizedPayload);
  if (!rawPayload || !normalizedPayload) throw new ResolutionDataIntegrityError();
  return {
    id: record.id,
    entityType: contractEntityType(record.entityType),
    rawPayload,
    normalizedPayload,
  };
}

function plainObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function requireSelected(selected: CandidateScore | null): CandidateScore {
  if (!selected) throw new ResolutionDataIntegrityError();
  return selected;
}

function storedExplanation(value: Prisma.JsonValue): ResolutionExplanation {
  const explanation = plainObject(value);
  if (!explanation) throw new ResolutionDataIntegrityError();
  return explanation as unknown as ResolutionExplanation;
}

function contractEntityType(entityType: DatabaseEntityType): EntityType {
  return entityType === DatabaseEntityType.PERSON ? EntityType.Person : EntityType.Company;
}

function databaseEntityType(entityType: EntityType): DatabaseEntityType {
  return entityType === EntityType.Person ? DatabaseEntityType.PERSON : DatabaseEntityType.COMPANY;
}

function contractDecision(decision: DatabaseMatchDecision): ResolutionDecision {
  if (decision === DatabaseMatchDecision.AUTO_MATCH) return ResolutionDecision.AutoMatch;
  if (decision === DatabaseMatchDecision.REVIEW) return ResolutionDecision.Review;
  return ResolutionDecision.NoMatch;
}

function databaseDecision(decision: ResolutionDecision): DatabaseMatchDecision {
  if (decision === ResolutionDecision.AutoMatch) return DatabaseMatchDecision.AUTO_MATCH;
  if (decision === ResolutionDecision.Review) return DatabaseMatchDecision.REVIEW;
  return DatabaseMatchDecision.NO_MATCH;
}

function roundForPersistence(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
