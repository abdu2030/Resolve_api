import type {
  ContradictionEvidence,
  ResolutionDecision,
  ResolutionExplanation,
  ResolutionOutcome,
} from '@resolve/contracts';

export interface CandidateScore {
  entityId: string;
  supportingRecordId: string;
  matchFeatureId: string;
  score: number;
  decision: ResolutionDecision;
  features: ResolutionExplanation['features'];
  contradictions: ContradictionEvidence[];
}

export interface CandidateSelection {
  decision: ResolutionDecision;
  candidateCount: number;
  selected: CandidateScore | null;
  additionalContradictions: ContradictionEvidence[];
}

export type ResolutionExecution = ResolutionOutcome;
