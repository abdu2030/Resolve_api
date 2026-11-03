import {
  measureQuality,
  type QualityDecision,
  type QualityObservation,
} from './quality-metrics.js';

function observation(
  id: string,
  same_identity: boolean,
  decision: QualityDecision,
  candidate_count = 1,
): QualityObservation {
  return { id, same_identity, decision, candidate_count };
}

describe('golden quality metrics', () => {
  it('counts unsafe links, missed links and deferred positives separately', () => {
    const result = measureQuality([
      observation('tp', true, 'AUTO_MATCH'),
      observation('fp', false, 'AUTO_MATCH'),
      observation('fn', true, 'NO_MATCH', 0),
      observation('tn', false, 'NO_MATCH', 0),
      observation('positive-review', true, 'REVIEW'),
      observation('negative-review', false, 'REVIEW'),
    ]);
    expect(result).toEqual({
      evaluated_pairs: 6,
      confusion: {
        same_identity: { AUTO_MATCH: 1, REVIEW: 1, NO_MATCH: 1 },
        different_identity: { AUTO_MATCH: 1, REVIEW: 1, NO_MATCH: 1 },
      },
      false_positives: 1,
      false_negatives: 1,
      deferred_positives: 1,
      precision: { numerator: 1, denominator: 2, value: 0.5 },
      recall: { numerator: 1, denominator: 3, value: 1 / 3 },
      false_positive_rate: { numerator: 1, denominator: 3, value: 1 / 3 },
      review_rate: { numerator: 2, denominator: 6, value: 1 / 3 },
      auto_resolution_rate: { numerator: 4, denominator: 6, value: 2 / 3 },
      positive_candidate_recall: { numerator: 2, denominator: 3, value: 2 / 3 },
    });
  });
  it('reports undefined denominators as null instead of claiming perfect accuracy', () => {
    expect(measureQuality([]).precision.value).toBeNull();
    expect(measureQuality([]).review_rate.value).toBeNull();
    const result = measureQuality([observation('review', true, 'REVIEW')]);
    expect(result.precision.value).toBeNull();
    expect(result.false_positive_rate.value).toBeNull();
    expect(result.recall.value).toBe(0);
    expect(result.false_negatives).toBe(0);
    expect(result.deferred_positives).toBe(1);
    expect(result.auto_resolution_rate.value).toBe(0);
  });
  it('rejects duplicate observations and impossible candidate counts', () => {
    const item = observation('same', true, 'AUTO_MATCH');
    expect(() => measureQuality([item, item])).toThrow('Duplicate quality case');
    expect(() => measureQuality([observation('negative', true, 'NO_MATCH', -1)])).toThrow(
      'Invalid candidate count',
    );
    expect(() => measureQuality([observation('fraction', true, 'REVIEW', 0.5)])).toThrow(
      'Invalid candidate count',
    );
  });
});
