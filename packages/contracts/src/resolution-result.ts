export enum ResolutionDecision {
  AutoMatch = 'AUTO_MATCH',
  NoMatch = 'NO_MATCH',
  Review = 'REVIEW',
}

export interface ContradictionEvidence {
  code: string;
  field?: string;
  message: string;
  severity: 'blocking' | 'warning';
}

export interface ResolutionExplanation {
  candidate_count: number;
  contradictions: ContradictionEvidence[];
  features: Record<string, boolean | null | number | string>;
}

export interface ResolutionResult {
  algorithm_version: string;
  confidence: number;
  created_at: string;
  decision: ResolutionDecision;
  entity_id: string;
  explanation: ResolutionExplanation;
  matched_against?: string;
  record_id: string;
}
