export const ENTITY_OPERATIONS_VERSION = 'entity-operations-v1';

export interface EntityOperationResult {
  operation_id: string;
  operation: 'MERGE' | 'SPLIT' | 'UNMERGE';
  operation_version: typeof ENTITY_OPERATIONS_VERSION;
  source_entity_id: string;
  target_entity_id: string;
  record_ids: string[];
  reason: string;
  actor_api_key_id: string;
  source_version_before: number;
  source_version_after: number;
  target_version_before: number;
  target_version_after: number;
  reversed_operation_id: string | null;
  created_at: string;
}
