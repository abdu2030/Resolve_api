import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  ENTITY_OPERATIONS_VERSION,
  type EntityOperationResult,
  type MergeEntityDto,
  type SplitEntityDto,
} from '@resolve/contracts';
import { type DatabaseEntityType, Prisma, type ResolvePrismaClient } from '@resolve/database';

import type { AuthPrincipal } from '../auth/auth-principal.js';
import { CanonicalizationService } from '../canonicalization/canonicalization.service.js';
import { acquireTransactionLock } from '../common/database/advisory-lock.js';
import { acquireEntityMembershipLock } from '../common/database/entity-membership-lock.js';
import { ApiException } from '../common/http/api-exception.js';
import { hashCanonicalJson } from '../common/json/canonical-json.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { EntityDataIntegrityError } from './entity-data-integrity.error.js';
import { mapEntityOperation } from './entity-operation.mapper.js';
import {
  assertActiveEntity,
  assertOperationBound,
  assertVersion,
  ENTITY_OPERATION_MAX_RECORDS,
  mergeRecordIds,
  splitRecordIds,
  reversalRecordIds,
  type OperationEntity,
} from './entity-operation-policy.js';

export interface EntityOperationExecution {
  body: EntityOperationResult;
  httpStatus: 200 | 201;
  replayed: boolean;
}
type OperationRequest =
  | { action: 'MERGE'; entityId: string; input: MergeEntityDto }
  | { action: 'SPLIT'; entityId: string; input: SplitEntityDto };
interface MutationPlan {
  type: 'MERGE' | 'SPLIT' | 'UNMERGE';
  source: OperationEntity;
  target: OperationEntity;
  recordIds: string[];
  reversedOperationId: string | null;
  newTargetType?: DatabaseEntityType;
}

@Injectable()
export class EntityManagementService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient,
    private readonly canonicalization: CanonicalizationService,
  ) {}

  merge(
    principal: AuthPrincipal,
    targetEntityId: string,
    input: MergeEntityDto,
    key: string,
  ): Promise<EntityOperationExecution> {
    return this.execute(
      principal,
      {
        action: 'MERGE',
        entityId: targetEntityId.toLowerCase(),
        input: {
          ...input,
          source_entity_id: input.source_entity_id.toLowerCase(),
          reason: input.reason.trim(),
        },
      },
      key,
    );
  }

  split(
    principal: AuthPrincipal,
    sourceEntityId: string,
    input: SplitEntityDto,
    key: string,
  ): Promise<EntityOperationExecution> {
    const selector =
      input.record_ids !== undefined
        ? { record_ids: input.record_ids.map((id) => id.toLowerCase()).sort() }
        : { merge_event_id: input.merge_event_id!.toLowerCase() };
    return this.execute(
      principal,
      {
        action: 'SPLIT',
        entityId: sourceEntityId.toLowerCase(),
        input: {
          ...selector,
          expected_version: input.expected_version,
          reason: input.reason.trim(),
        },
      },
      key,
    );
  }

  private execute(
    principal: AuthPrincipal,
    request: OperationRequest,
    key: string,
  ): Promise<EntityOperationExecution> {
    const { tenantId } = principal;
    const operation = `POST /v1/entities/${request.entityId}/${request.action.toLowerCase()}`;
    const requestHash = hashCanonicalJson(request);
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
        return {
          body: replay.responseBody as unknown as EntityOperationResult,
          httpStatus: replay.responseStatus as 200 | 201,
          replayed: true,
        };
      }
      await acquireEntityMembershipLock(transaction, tenantId, 'exclusive');
      const actor = await transaction.apiKey.findUnique({
        where: { tenantId_id: { tenantId, id: principal.apiKeyId } },
        select: { id: true },
      });
      if (!actor) throw new ApiException(404, 'ENTITY_NOT_FOUND', 'Entity does not exist');
      const plan = await this.plan(transaction, tenantId, request);
      if (plan.newTargetType)
        await transaction.entity.create({
          data: { id: plan.target.id, tenantId, entityType: plan.newTargetType },
        });
      const event = await transaction.entityOperation.create({
        data: {
          tenantId,
          type: plan.type,
          operationVersion: ENTITY_OPERATIONS_VERSION,
          sourceEntityId: plan.source.id,
          targetEntityId: plan.target.id,
          recordIds: plan.recordIds,
          reason: request.input.reason,
          actorApiKeyId: principal.apiKeyId,
          sourceVersionBefore: plan.source.canonicalVersion,
          sourceVersionAfter: plan.source.canonicalVersion + 1,
          targetVersionBefore: plan.target.canonicalVersion,
          targetVersionAfter: plan.target.canonicalVersion + 1,
          reversedOperationId: plan.reversedOperationId,
        },
      });
      const moved = await transaction.entityRecordLink.updateMany({
        where: { tenantId, entityId: plan.source.id, sourceRecordId: { in: plan.recordIds } },
        data: { entityId: plan.target.id, lastEntityOperationId: event.id },
      });
      if (moved.count !== plan.recordIds.length)
        throw new ApiException(409, 'ENTITY_MEMBERSHIP_CONFLICT', 'Entity membership changed');
      if (plan.type === 'MERGE')
        await transaction.entity.update({
          where: { tenantId_id: { tenantId, id: plan.source.id } },
          data: { status: 'MERGED', mergedIntoEntityId: plan.target.id },
        });
      if (plan.type === 'UNMERGE')
        await transaction.entity.update({
          where: { tenantId_id: { tenantId, id: plan.target.id } },
          data: { status: 'ACTIVE', mergedIntoEntityId: null },
        });
      for (const entityId of [plan.source.id, plan.target.id].sort())
        await this.canonicalization.recomputeAfterEntityOperation(transaction, {
          tenantId,
          entityId,
          entityOperationId: event.id,
          operation: plan.type === 'MERGE' ? 'MERGE' : 'SPLIT',
        });
      const execution: EntityOperationExecution = {
        body: mapEntityOperation(event),
        httpStatus: plan.type === 'SPLIT' ? 201 : 200,
        replayed: false,
      };
      await transaction.idempotencyRequest.create({
        data: {
          tenantId,
          key,
          operation,
          requestHash,
          responseStatus: execution.httpStatus,
          responseBody: execution.body as unknown as Prisma.InputJsonObject,
        },
      });
      return execution;
    });
  }

  private async plan(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    request: OperationRequest,
  ): Promise<MutationPlan> {
    let mergeEvent: Prisma.EntityOperationGetPayload<Record<string, never>> | null = null;
    if (request.action === 'SPLIT' && request.input.merge_event_id) {
      mergeEvent = await transaction.entityOperation.findFirst({
        where: {
          tenantId,
          id: request.input.merge_event_id,
          targetEntityId: request.entityId,
          type: 'MERGE',
        },
      });
      if (!mergeEvent)
        throw new ApiException(404, 'MERGE_EVENT_NOT_FOUND', 'Merge event does not exist');
    }
    const otherId =
      request.action === 'MERGE'
        ? request.input.source_entity_id
        : (mergeEvent?.sourceEntityId ?? randomUUID());
    for (const id of [...new Set([request.entityId, otherId])].sort())
      await acquireTransactionLock(transaction, `canonicalization:${tenantId}:${id}`);
    const pathEntity = await requireEntity(transaction, tenantId, request.entityId);
    if (request.action === 'MERGE') {
      const source = await requireEntity(transaction, tenantId, otherId);
      const links = await membership(transaction, tenantId, [source.id, pathEntity.id]);
      const sourceIds = links
        .filter((link) => link.entityId === source.id)
        .map((link) => link.sourceRecordId);
      const targetIds = links
        .filter((link) => link.entityId === pathEntity.id)
        .map((link) => link.sourceRecordId);
      const recordIds = mergeRecordIds(source, pathEntity, sourceIds, targetIds);
      assertVersion(source, request.input.expected_source_version);
      assertVersion(pathEntity, request.input.expected_target_version);
      return { type: 'MERGE', source, target: pathEntity, recordIds, reversedOperationId: null };
    }
    assertActiveEntity(pathEntity);
    assertVersion(pathEntity, request.input.expected_version);
    const links = await membership(transaction, tenantId, [pathEntity.id]);
    const members = links.map((link) => link.sourceRecordId);
    if (!mergeEvent) {
      const recordIds = splitRecordIds(members, request.input.record_ids ?? []);
      return {
        type: 'SPLIT',
        source: pathEntity,
        target: {
          id: otherId,
          status: 'ACTIVE',
          entityType: pathEntity.entityType,
          canonicalVersion: 0,
        },
        recordIds,
        reversedOperationId: null,
        newTargetType: pathEntity.entityType,
      };
    }
    // Only verified same-tenant event members may produce a reversal state conflict.
    const original = mapEntityOperation(mergeEvent);
    const reversed = await transaction.entityOperation.findUnique({
      where: { tenantId_reversedOperationId: { tenantId, reversedOperationId: mergeEvent.id } },
      select: { id: true },
    });
    const restored = await requireEntity(transaction, tenantId, otherId);
    const strayLink = await transaction.entityRecordLink.findFirst({
      where: { tenantId, entityId: restored.id },
      select: { id: true },
    });
    const recordIds = reversalRecordIds(
      restored,
      pathEntity.id,
      members,
      original.record_ids,
      Boolean(reversed),
      Boolean(strayLink),
    );
    assertVersion(restored, restored.canonicalVersion);
    return {
      type: 'UNMERGE',
      source: pathEntity,
      target: restored,
      recordIds,
      reversedOperationId: mergeEvent.id,
    };
  }
}

async function requireEntity(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<Prisma.EntityGetPayload<Record<string, never>>> {
  const entity = await transaction.entity.findUnique({ where: { tenantId_id: { tenantId, id } } });
  if (!entity) throw new ApiException(404, 'ENTITY_NOT_FOUND', 'Entity does not exist');
  return entity;
}
async function membership(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  entityIds: string[],
): Promise<{ entityId: string; sourceRecordId: string }[]> {
  const links = await transaction.entityRecordLink.findMany({
    where: { tenantId, entityId: { in: entityIds } },
    select: { entityId: true, sourceRecordId: true },
    orderBy: { sourceRecordId: 'asc' },
    take: ENTITY_OPERATION_MAX_RECORDS + 1,
  });
  assertOperationBound(links.length);
  if (new Set(links.map((link) => link.sourceRecordId)).size !== links.length)
    throw new EntityDataIntegrityError();
  return links;
}
