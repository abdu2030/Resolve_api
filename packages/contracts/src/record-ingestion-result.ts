import type { EntityType } from './entity-type.js';
import type { ResolutionResult } from './resolution-result.js';

export type IngestionOperation = 'CREATED' | 'UPDATED' | 'UNCHANGED';

export interface RecordIngestionResult extends ResolutionResult {
  source_id: string;
  external_id: string;
  entity_type: EntityType;
  version: number;
  status: 'STORED';
  operation: IngestionOperation;
  updated_at: string;
}
