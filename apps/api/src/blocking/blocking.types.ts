import type { DatabaseEntityType } from '@resolve/database';

import type { BLOCKING_SIGNAL_PRIORITY, BLOCKING_VERSION } from './blocking-policy.js';

export type BlockingSignal = (typeof BLOCKING_SIGNAL_PRIORITY)[number];

export interface BlockingCandidate {
  entityId: string;
  entityType: DatabaseEntityType;
  matchedOn: BlockingSignal[];
  supportingRecordIds: string[];
}

export interface BlockingResult {
  blockingVersion: typeof BLOCKING_VERSION;
  candidates: BlockingCandidate[];
  truncated: boolean;
}

export interface BlockingQueryRow {
  entityId: string;
  entityType: DatabaseEntityType;
  supportingRecordId: string;
}

export interface BlockingPassRows {
  signal: BlockingSignal;
  rows: BlockingQueryRow[];
}
