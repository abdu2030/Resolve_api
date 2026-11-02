import { ENTITY_OPERATIONS_VERSION, type EntityOperationResult } from '@resolve/contracts';
import type { Prisma } from '@resolve/database';

import { EntityDataIntegrityError } from './entity-data-integrity.error.js';

type EntityOperationRow = Prisma.EntityOperationGetPayload<Record<string, never>>;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function mapEntityOperation(row: EntityOperationRow): EntityOperationResult {
  if (
    ![row.id, row.sourceEntityId, row.targetEntityId, row.actorApiKeyId].every((value) =>
      UUID_V4.test(value),
    ) ||
    row.sourceEntityId === row.targetEntityId ||
    !['MERGE', 'SPLIT', 'UNMERGE'].includes(row.type) ||
    row.operationVersion !== ENTITY_OPERATIONS_VERSION ||
    !validRecordIds(row.recordIds) ||
    typeof row.reason !== 'string' ||
    row.reason.trim().length < 1 ||
    [...row.reason].length > 500 ||
    ![
      row.sourceVersionBefore,
      row.sourceVersionAfter,
      row.targetVersionBefore,
      row.targetVersionAfter,
    ].every((value) => Number.isInteger(value) && value >= 0 && value <= 2147483647) ||
    (row.type === 'UNMERGE'
      ? typeof row.reversedOperationId !== 'string' || !UUID_V4.test(row.reversedOperationId)
      : row.reversedOperationId !== null) ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  )
    throw new EntityDataIntegrityError();

  return {
    operation_id: row.id,
    operation: row.type,
    operation_version: ENTITY_OPERATIONS_VERSION,
    source_entity_id: row.sourceEntityId,
    target_entity_id: row.targetEntityId,
    record_ids: [...row.recordIds],
    reason: row.reason,
    actor_api_key_id: row.actorApiKeyId,
    source_version_before: row.sourceVersionBefore,
    source_version_after: row.sourceVersionAfter,
    target_version_before: row.targetVersionBefore,
    target_version_after: row.targetVersionAfter,
    reversed_operation_id: row.reversedOperationId,
    created_at: row.createdAt.toISOString(),
  };
}

function validRecordIds(value: Prisma.JsonValue): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) return false;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !UUID_V4.test(id)) return false;
    ids.push(id.toLowerCase());
  }
  return new Set(ids).size === ids.length;
}
