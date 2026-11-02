import { ApiException } from '../common/http/api-exception.js';

export const ENTITY_OPERATION_MAX_RECORDS = 1000;
export interface OperationEntity {
  id: string;
  status: string;
  entityType: string;
  canonicalVersion: number;
}
export function assertActiveEntity(entity: OperationEntity): void {
  if (entity.status !== 'ACTIVE')
    throw new ApiException(409, 'ENTITY_NOT_ACTIVE', 'Entity is not active');
}
export function assertVersion(entity: OperationEntity, expected: number): void {
  if (entity.canonicalVersion !== expected || entity.canonicalVersion >= 2147483647)
    throw new ApiException(
      409,
      'ENTITY_VERSION_CONFLICT',
      'Entity version conflicts with the requested operation',
    );
}
export function assertOperationBound(count: number): void {
  if (count > ENTITY_OPERATION_MAX_RECORDS)
    throw new ApiException(
      422,
      'ENTITY_OPERATION_LIMIT',
      'Entity operation exceeds the record limit',
    );
}
export function mergeRecordIds(
  source: OperationEntity,
  target: OperationEntity,
  sourceIds: string[],
  targetIds: string[],
): string[] {
  if (source.id.toLowerCase() === target.id.toLowerCase())
    throw new ApiException(409, 'INVALID_ENTITY_MERGE', 'Cannot merge an entity into itself');
  assertActiveEntity(source);
  assertActiveEntity(target);
  if (source.entityType !== target.entityType)
    throw new ApiException(409, 'ENTITY_TYPE_CONFLICT', 'Entities must have the same type');
  assertOperationBound(sourceIds.length + targetIds.length);
  if (!sourceIds.length || !targetIds.length)
    throw new ApiException(409, 'INVALID_ENTITY_MERGE', 'Both entities must have linked records');
  return sourceIds.map((id) => id.toLowerCase()).sort();
}
export function splitRecordIds(members: string[], selected: string[]): string[] {
  assertOperationBound(members.length);
  const ids = selected.map((id) => id.toLowerCase()).sort();
  const owned = new Set(members.map((id) => id.toLowerCase()));
  if (ids.some((id) => !owned.has(id)))
    throw new ApiException(404, 'SOURCE_RECORD_NOT_FOUND', 'Source record does not exist');
  if (!ids.length || new Set(ids).size !== ids.length || ids.length >= members.length)
    throw new ApiException(
      409,
      'INVALID_ENTITY_SPLIT',
      'Split must select a nonempty proper subset',
    );
  return ids;
}

export function reversalRecordIds(
  restored: OperationEntity & { mergedIntoEntityId: string | null },
  currentEntityId: string,
  members: string[],
  eventRecordIds: string[],
  alreadyReversed: boolean,
  restoredHasLinks: boolean,
): string[] {
  if (alreadyReversed)
    throw new ApiException(409, 'MERGE_ALREADY_REVERSED', 'Merge was already reversed');
  const owned = new Set(members.map((id) => id.toLowerCase()));
  const ids = eventRecordIds.map((id) => id.toLowerCase()).sort();
  if (
    restored.status !== 'MERGED' ||
    restored.mergedIntoEntityId?.toLowerCase() !== currentEntityId.toLowerCase() ||
    restoredHasLinks ||
    !ids.length ||
    ids.some((id) => !owned.has(id)) ||
    ids.length >= members.length
  )
    throw new ApiException(
      409,
      'MERGE_REVERSAL_CONFLICT',
      'Merge can no longer be reversed safely',
    );
  return ids;
}
