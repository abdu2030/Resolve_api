import { ResolutionDecision } from '@resolve/contracts';

import { selectResolutionOutcome } from './candidate-selection.js';
import type { CandidateScore } from './resolution.types.js';

function candidate(
  entityId: string,
  supportingRecordId: string,
  score: number,
  decision: ResolutionDecision,
): CandidateScore {
  return {
    entityId,
    supportingRecordId,
    matchFeatureId: 'feature-' + supportingRecordId,
    score,
    decision,
    features: { email_exact: score >= 0.92 },
    contradictions: [],
  };
}

describe('selectResolutionOutcome', () => {
  it('selects the only automatic candidate over review candidates', () => {
    const selected = selectResolutionOutcome([
      candidate('entity-b', 'record-b', 0.8, ResolutionDecision.Review),
      candidate('entity-a', 'record-a', 0.95, ResolutionDecision.AutoMatch),
    ]);

    expect(selected).toMatchObject({
      decision: ResolutionDecision.AutoMatch,
      candidateCount: 2,
      selected: { entityId: 'entity-a' },
      additionalContradictions: [],
    });
  });

  it('sends multiple automatic candidates to review instead of guessing', () => {
    const selected = selectResolutionOutcome([
      candidate('entity-b', 'record-b', 0.96, ResolutionDecision.AutoMatch),
      candidate('entity-a', 'record-a', 0.96, ResolutionDecision.AutoMatch),
    ]);

    expect(selected.decision).toBe(ResolutionDecision.Review);
    expect(selected.selected?.entityId).toBe('entity-a');
    expect(selected.additionalContradictions).toEqual([
      {
        code: 'MULTIPLE_AUTO_MATCH_CANDIDATES',
        message: 'More than one existing entity met the automatic-match threshold.',
        severity: 'blocking',
      },
    ]);
  });

  it('keeps the highest scoring supporting record for each entity', () => {
    const selected = selectResolutionOutcome([
      candidate('entity-a', 'record-b', 0.8, ResolutionDecision.Review),
      candidate('entity-a', 'record-a', 0.85, ResolutionDecision.Review),
    ]);

    expect(selected.candidateCount).toBe(1);
    expect(selected.selected?.supportingRecordId).toBe('record-a');
  });

  it('uses supporting record id to break equal-score ties for one entity', () => {
    const selected = selectResolutionOutcome([
      candidate('entity-a', 'record-b', 0.85, ResolutionDecision.Review),
      candidate('entity-a', 'record-a', 0.85, ResolutionDecision.Review),
    ]);

    expect(selected.selected?.supportingRecordId).toBe('record-a');
  });

  it('selects the strongest review candidate when no candidate can auto-match', () => {
    const selected = selectResolutionOutcome([
      candidate('entity-b', 'record-b', 0.8, ResolutionDecision.Review),
      candidate('entity-a', 'record-a', 0.85, ResolutionDecision.Review),
    ]);

    expect(selected).toMatchObject({
      decision: ResolutionDecision.Review,
      candidateCount: 2,
      selected: { entityId: 'entity-a', score: 0.85 },
    });
  });

  it('returns no match with the strongest rejected candidate', () => {
    const selected = selectResolutionOutcome([
      candidate('entity-b', 'record-b', 0.4, ResolutionDecision.NoMatch),
      candidate('entity-a', 'record-a', 0.6, ResolutionDecision.NoMatch),
    ]);

    expect(selected).toMatchObject({
      decision: ResolutionDecision.NoMatch,
      candidateCount: 2,
      selected: { entityId: 'entity-a', score: 0.6 },
    });
  });

  it('returns no match with no candidate for an empty set', () => {
    expect(selectResolutionOutcome([])).toEqual({
      decision: ResolutionDecision.NoMatch,
      candidateCount: 0,
      selected: null,
      additionalContradictions: [],
    });
  });
});
