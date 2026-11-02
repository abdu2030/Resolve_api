import type { EntityType } from '@resolve/contracts';

import type { CANONICALIZATION_VERSION } from './canonicalization.constants.js';

export interface CanonicalizationRecord {
  id: string;
  externalId: string;
  updatedAt: Date;
  rawPayload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown>;
  normalizationVersion: string;
  source: { id: string; name: string; priority: number };
}

export type CanonicalSelectionRule =
  'ONLY_CANDIDATE' | 'SOURCE_PRIORITY' | 'COMPLETENESS' | 'RECENCY' | 'STABLE_TIE_BREAK';

export interface CanonicalFieldSelection {
  fieldPath: string;
  canonicalValue: string;
  rawValue: string;
  sourceRecordId: string;
  sourceSystemId: string;
  sourceSystemName: string;
  externalId: string;
  sourcePriority: number;
  selectionRule: CanonicalSelectionRule;
  completenessScore: number;
  observedAt: Date;
  normalizationVersion: string;
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
}

export interface CanonicalProjection {
  canonicalData: Record<string, unknown>;
  provenance: Record<string, unknown>;
  fields: CanonicalFieldSelection[];
}

export type CanonicalTriggerOperation =
  'ENTITY_CREATED' | 'RECORD_LINKED' | 'RECORD_UPDATED' | 'LEGACY_BACKFILL' | 'MERGE' | 'SPLIT';

export type CanonicalEntityType = EntityType;
