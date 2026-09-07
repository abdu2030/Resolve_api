import type { EntityType } from './entity-type.js';

export type IngestionOperation = 'CREATED' | 'UPDATED' | 'UNCHANGED';

export interface RecordIngestionResult {
  record_id: string;
  source_id: string;
  external_id: string;
  entity_type: EntityType;
  version: number;
  status: 'STORED';
  operation: IngestionOperation;
  created_at: string;
  updated_at: string;
}
