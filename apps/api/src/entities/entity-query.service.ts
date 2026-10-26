import { Inject, Injectable } from '@nestjs/common';
import { EntityType, ResolutionDecision } from '@resolve/contracts';
import {
  DatabaseEntityType,
  DatabaseMatchDecision,
  type Prisma,
  type ResolvePrismaClient,
} from '@resolve/database';

import { ApiException } from '../common/http/api-exception.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import {
  decodeHistoryCursor,
  decodeRecordCursor,
  encodeHistoryCursor,
  encodeRecordCursor,
} from './entity-cursor.js';
import { EntityDataIntegrityError } from './entity-data-integrity.error.js';
import type { EntityPageQueryDto } from './entity-pagination.dto.js';
import type {
  EntityHistoryPageDto,
  EntityHistoryResponseDto,
  EntityResponseDto,
  LinkedRecordPageDto,
  LinkedRecordResponseDto,
} from './entity-response.dto.js';

const DEFAULT_PAGE_LIMIT = 25;

@Injectable()
export class EntityQueryService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient) {}

  async getEntity(tenantId: string, entityId: string): Promise<EntityResponseDto> {
    // Prisma loads relations with separate statements; all must see the same canonical version.
    const entity = await this.prisma.$transaction(
      (transaction) =>
        transaction.entity.findUnique({
          where: { tenantId_id: { tenantId, id: entityId } },
          select: {
            id: true,
            entityType: true,
            canonicalData: true,
            canonicalVersion: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { entityRecordLinks: { where: { tenantId } } } },
            fieldProvenance: {
              where: { tenantId },
              orderBy: { fieldPath: 'asc' },
              select: {
                fieldPath: true,
                canonicalValue: true,
                rawValue: true,
                sourceRecordId: true,
                sourceSystemId: true,
                sourceExternalId: true,
                sourcePriority: true,
                selectionRule: true,
                completenessScore: true,
                observedAt: true,
                normalizationVersion: true,
                canonicalizationVersion: true,
                sourceSystem: { select: { name: true } },
              },
            },
            canonicalVersions: {
              where: { tenantId },
              orderBy: { version: 'desc' },
              take: 1,
              select: { version: true, canonicalizationVersion: true },
            },
          },
        }),
      { isolationLevel: 'RepeatableRead' },
    );
    if (!entity) throw entityNotFound();
    const canonicalData = requirePlainObject(entity.canonicalData);
    if (entity.canonicalVersion === 0) {
      return {
        entity_id: entity.id,
        entity_type: contractEntityType(entity.entityType),
        canonical_data: canonicalData,
        canonical_version: 0,
        canonicalization_version: null,
        provenance: {},
        record_count: entity._count.entityRecordLinks,
        created_at: entity.createdAt.toISOString(),
        updated_at: entity.updatedAt.toISOString(),
      };
    }
    const latest = entity.canonicalVersions[0];
    if (!latest || latest.version !== entity.canonicalVersion) {
      throw new EntityDataIntegrityError();
    }

    const provenance: Record<string, unknown> = {};
    for (const field of entity.fieldProvenance) {
      addProvenance(provenance, field.fieldPath, {
        source_record_id: field.sourceRecordId,
        source_system_id: field.sourceSystemId,
        source_system_name: field.sourceSystem.name,
        external_id: field.sourceExternalId,
        source_priority: field.sourcePriority,
        raw_value: field.rawValue,
        canonical_value: field.canonicalValue,
        selection_rule: field.selectionRule,
        completeness_score: field.completenessScore,
        observed_at: field.observedAt.toISOString(),
        normalization_version: field.normalizationVersion,
        canonicalization_version: field.canonicalizationVersion,
      });
    }

    return {
      entity_id: entity.id,
      entity_type: contractEntityType(entity.entityType),
      canonical_data: canonicalData,
      canonical_version: entity.canonicalVersion,
      canonicalization_version: latest.canonicalizationVersion,
      provenance,
      record_count: entity._count.entityRecordLinks,
      created_at: entity.createdAt.toISOString(),
      updated_at: entity.updatedAt.toISOString(),
    };
  }

  async listRecords(
    tenantId: string,
    entityId: string,
    query: EntityPageQueryDto,
  ): Promise<LinkedRecordPageDto> {
    await this.requireEntity(tenantId, entityId);
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const cursor = query.cursor === undefined ? null : decodeRecordCursor(query.cursor);
    const rows = await this.prisma.entityRecordLink.findMany({
      where: {
        tenantId,
        entityId,
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
      select: {
        id: true,
        score: true,
        decision: true,
        algorithmVersion: true,
        explanation: true,
        createdAt: true,
        sourceRecord: {
          select: {
            id: true,
            entityType: true,
            externalId: true,
            rawPayload: true,
            normalizedPayload: true,
            normalizationVersion: true,
            createdAt: true,
            updatedAt: true,
            sourceSystem: {
              select: { id: true, name: true, type: true, priority: true },
            },
          },
        },
      },
    });
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(mapLinkedRecord),
      next_cursor:
        hasMore && pageRows.length > 0
          ? encodeRecordCursor({
              createdAt: pageRows[pageRows.length - 1]!.createdAt,
              id: pageRows[pageRows.length - 1]!.id,
            })
          : null,
    };
  }

  async listHistory(
    tenantId: string,
    entityId: string,
    query: EntityPageQueryDto,
  ): Promise<EntityHistoryPageDto> {
    await this.requireEntity(tenantId, entityId);
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const cursor = query.cursor === undefined ? null : decodeHistoryCursor(query.cursor);
    const rows = await this.prisma.entityCanonicalVersion.findMany({
      where: {
        tenantId,
        entityId,
        ...(cursor === null ? {} : { version: { lt: cursor } }),
      },
      orderBy: { version: 'desc' },
      take: limit + 1,
      select: {
        version: true,
        canonicalData: true,
        provenance: true,
        triggerSourceRecordId: true,
        triggerOperation: true,
        canonicalizationVersion: true,
        createdAt: true,
      },
    });
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(mapHistory),
      next_cursor:
        hasMore && pageRows.length > 0
          ? encodeHistoryCursor(pageRows[pageRows.length - 1]!.version)
          : null,
    };
  }

  private async requireEntity(tenantId: string, entityId: string): Promise<void> {
    const entity = await this.prisma.entity.findUnique({
      where: { tenantId_id: { tenantId, id: entityId } },
      select: { id: true },
    });
    if (!entity) throw entityNotFound();
  }
}

function mapLinkedRecord(row: {
  score: { toString(): string };
  decision: DatabaseMatchDecision;
  algorithmVersion: string;
  explanation: Prisma.JsonValue;
  createdAt: Date;
  sourceRecord: {
    id: string;
    entityType: DatabaseEntityType;
    externalId: string;
    rawPayload: Prisma.JsonValue;
    normalizedPayload: Prisma.JsonValue | null;
    normalizationVersion: string | null;
    createdAt: Date;
    updatedAt: Date;
    sourceSystem: { id: string; name: string; type: string; priority: number };
  };
}): LinkedRecordResponseDto {
  const record = row.sourceRecord;
  if (!record.normalizationVersion) throw new EntityDataIntegrityError();
  return {
    record_id: record.id,
    entity_type: contractEntityType(record.entityType),
    external_id: record.externalId,
    source: {
      source_system_id: record.sourceSystem.id,
      name: record.sourceSystem.name,
      type: record.sourceSystem.type,
      priority: record.sourceSystem.priority,
    },
    raw_payload: requirePlainObject(record.rawPayload),
    normalized_payload: requirePlainObject(record.normalizedPayload),
    normalization_version: record.normalizationVersion,
    record_created_at: record.createdAt.toISOString(),
    record_updated_at: record.updatedAt.toISOString(),
    link: {
      decision: contractDecision(row.decision),
      confidence: Number(row.score),
      algorithm_version: row.algorithmVersion,
      explanation: requirePlainObject(row.explanation),
      linked_at: row.createdAt.toISOString(),
    },
  };
}

function mapHistory(row: {
  version: number;
  canonicalData: Prisma.JsonValue;
  provenance: Prisma.JsonValue;
  triggerSourceRecordId: string | null;
  triggerOperation: 'ENTITY_CREATED' | 'RECORD_LINKED' | 'RECORD_UPDATED' | 'LEGACY_BACKFILL';
  canonicalizationVersion: string;
  createdAt: Date;
}): EntityHistoryResponseDto {
  return {
    version: row.version,
    canonical_data: requirePlainObject(row.canonicalData),
    provenance: mapHistoryProvenance(row.provenance),
    trigger: {
      operation: row.triggerOperation,
      source_record_id: row.triggerSourceRecordId,
    },
    canonicalization_version: row.canonicalizationVersion,
    created_at: row.createdAt.toISOString(),
  };
}

function mapHistoryProvenance(value: Prisma.JsonValue): Record<string, unknown> {
  const provenance: Record<string, unknown> = {};
  for (const [fieldPath, field] of Object.entries(requirePlainObject(value))) {
    if (fieldPath === 'address') {
      for (const [addressField, selection] of Object.entries(requirePlainObject(field))) {
        addProvenance(provenance, `address.${addressField}`, mapHistoryField(selection));
      }
    } else {
      addProvenance(provenance, fieldPath, mapHistoryField(field));
    }
  }
  return provenance;
}

function mapHistoryField(value: unknown): Record<string, unknown> {
  const field = requirePlainObject(value);
  for (const key of [
    'sourceRecordId',
    'sourceSystemId',
    'sourceSystemName',
    'externalId',
    'canonicalValue',
    'rawValue',
    'normalizationVersion',
    'canonicalizationVersion',
  ]) {
    if (typeof field[key] !== 'string') throw new EntityDataIntegrityError();
  }
  if (
    typeof field.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(field.observedAt)) ||
    typeof field.selectionRule !== 'string' ||
    !['ONLY_CANDIDATE', 'SOURCE_PRIORITY', 'COMPLETENESS', 'RECENCY', 'STABLE_TIE_BREAK'].includes(
      field.selectionRule,
    ) ||
    typeof field.sourcePriority !== 'number' ||
    !Number.isInteger(field.sourcePriority) ||
    field.sourcePriority < 0 ||
    field.sourcePriority > 1000 ||
    typeof field.completenessScore !== 'number' ||
    !Number.isInteger(field.completenessScore) ||
    field.completenessScore < 0
  ) {
    throw new EntityDataIntegrityError();
  }

  // Source metadata belongs to the historical snapshot, even after a source changes.
  return {
    source_record_id: field.sourceRecordId,
    source_system_id: field.sourceSystemId,
    source_system_name: field.sourceSystemName,
    external_id: field.externalId,
    source_priority: field.sourcePriority,
    raw_value: field.rawValue,
    canonical_value: field.canonicalValue,
    selection_rule: field.selectionRule,
    completeness_score: field.completenessScore,
    observed_at: field.observedAt,
    normalization_version: field.normalizationVersion,
    canonicalization_version: field.canonicalizationVersion,
  };
}

function requirePlainObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new EntityDataIntegrityError();
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function contractEntityType(value: DatabaseEntityType): EntityType {
  switch (value) {
    case DatabaseEntityType.PERSON:
      return EntityType.Person;
    case DatabaseEntityType.COMPANY:
      return EntityType.Company;
  }
}

function contractDecision(value: DatabaseMatchDecision): ResolutionDecision {
  switch (value) {
    case DatabaseMatchDecision.AUTO_MATCH:
      return ResolutionDecision.AutoMatch;
    case DatabaseMatchDecision.NO_MATCH:
      return ResolutionDecision.NoMatch;
    case DatabaseMatchDecision.REVIEW:
      return ResolutionDecision.Review;
  }
}

function addProvenance(
  target: Record<string, unknown>,
  fieldPath: string,
  value: Record<string, unknown>,
): void {
  switch (fieldPath) {
    case 'name':
    case 'email':
    case 'phone':
    case 'company':
    case 'company_domain':
    case 'domain':
    case 'registration_id':
      target[fieldPath] = value;
      return;
    case 'address.line1':
    case 'address.city':
    case 'address.region':
    case 'address.postal_code':
    case 'address.country':
      provenanceAddress(target)[fieldPath.slice('address.'.length)] = value;
      return;
    default:
      throw new EntityDataIntegrityError();
  }
}

function provenanceAddress(target: Record<string, unknown>): Record<string, unknown> {
  const current = target.address;
  if (isPlainObject(current)) return current;
  const address: Record<string, unknown> = {};
  target.address = address;
  return address;
}

function entityNotFound(): ApiException {
  return new ApiException(404, 'ENTITY_NOT_FOUND', 'Entity does not exist');
}
