import { ResolutionDecision, type ContradictionEvidence } from '@resolve/contracts';

import type { CandidateScore, CandidateSelection } from './resolution.types.js';

const MULTIPLE_AUTO_MATCH_CONTRADICTION: ContradictionEvidence = {
  code: 'MULTIPLE_AUTO_MATCH_CANDIDATES',
  message: 'More than one existing entity met the automatic-match threshold.',
  severity: 'blocking',
};

export function selectResolutionOutcome(scores: CandidateScore[]): CandidateSelection {
  const candidates = bestScorePerEntity(scores);
  const automatic = candidates.filter(({ decision }) => decision === ResolutionDecision.AutoMatch);

  if (automatic.length === 1) {
    return selection(ResolutionDecision.AutoMatch, candidates.length, automatic[0]!);
  }

  if (automatic.length > 1) {
    return {
      ...selection(ResolutionDecision.Review, candidates.length, automatic[0]!),
      additionalContradictions: [{ ...MULTIPLE_AUTO_MATCH_CONTRADICTION }],
    };
  }

  const review = candidates.find(({ decision }) => decision === ResolutionDecision.Review);
  if (review) return selection(ResolutionDecision.Review, candidates.length, review);

  return selection(ResolutionDecision.NoMatch, candidates.length, candidates[0] ?? null);
}

function bestScorePerEntity(scores: CandidateScore[]): CandidateScore[] {
  const candidates = new Map<string, CandidateScore>();

  for (const score of scores) {
    const current = candidates.get(score.entityId);
    if (!current || compareScores(score, current) < 0) candidates.set(score.entityId, score);
  }

  return [...candidates.values()].sort(compareScores);
}

function compareScores(left: CandidateScore, right: CandidateScore): number {
  if (left.score !== right.score) return right.score - left.score;
  const entityOrder = compareText(left.entityId, right.entityId);
  return entityOrder === 0
    ? compareText(left.supportingRecordId, right.supportingRecordId)
    : entityOrder;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function selection(
  decision: ResolutionDecision,
  candidateCount: number,
  selected: CandidateScore | null,
): CandidateSelection {
  return {
    decision,
    candidateCount,
    selected,
    additionalContradictions: [],
  };
}
