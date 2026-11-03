export type QualityDecision = 'AUTO_MATCH' | 'REVIEW' | 'NO_MATCH';

export interface QualityObservation {
  id: string;
  same_identity: boolean;
  decision: QualityDecision;
  candidate_count: number;
}

export interface QualityRate {
  numerator: number;
  denominator: number;
  value: number | null;
}

function rate(numerator: number, denominator: number): QualityRate {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

/** REVIEW is an abstention. Recall measures actual automatic links over all known positives. */
export function measureQuality(observations: readonly QualityObservation[]): {
  evaluated_pairs: number;
  confusion: Record<'same_identity' | 'different_identity', Record<QualityDecision, number>>;
  false_positives: number;
  false_negatives: number;
  deferred_positives: number;
  precision: QualityRate;
  recall: QualityRate;
  false_positive_rate: QualityRate;
  review_rate: QualityRate;
  auto_resolution_rate: QualityRate;
  positive_candidate_recall: QualityRate;
} {
  const confusion = {
    same_identity: { AUTO_MATCH: 0, REVIEW: 0, NO_MATCH: 0 },
    different_identity: { AUTO_MATCH: 0, REVIEW: 0, NO_MATCH: 0 },
  };
  const ids = new Set<string>();
  let positiveCandidates = 0;
  for (const observation of observations) {
    if (ids.has(observation.id)) throw new Error(`Duplicate quality case: ${observation.id}`);
    if (!Number.isInteger(observation.candidate_count) || observation.candidate_count < 0)
      throw new Error(`Invalid candidate count: ${observation.id}`);
    ids.add(observation.id);
    confusion[observation.same_identity ? 'same_identity' : 'different_identity'][
      observation.decision
    ]++;
    if (observation.same_identity && observation.candidate_count > 0) positiveCandidates++;
  }
  const positive = confusion.same_identity;
  const negative = confusion.different_identity;
  const positives = positive.AUTO_MATCH + positive.REVIEW + positive.NO_MATCH;
  const negatives = negative.AUTO_MATCH + negative.REVIEW + negative.NO_MATCH;
  const autoMatches = positive.AUTO_MATCH + negative.AUTO_MATCH;
  const reviews = positive.REVIEW + negative.REVIEW;
  return {
    evaluated_pairs: observations.length,
    confusion,
    false_positives: negative.AUTO_MATCH,
    false_negatives: positive.NO_MATCH,
    deferred_positives: positive.REVIEW,
    precision: rate(positive.AUTO_MATCH, autoMatches),
    recall: rate(positive.AUTO_MATCH, positives),
    false_positive_rate: rate(negative.AUTO_MATCH, negatives),
    review_rate: rate(reviews, observations.length),
    auto_resolution_rate: rate(observations.length - reviews, observations.length),
    positive_candidate_recall: rate(positiveCandidates, positives),
  };
}
