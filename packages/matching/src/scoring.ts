import {
  EntityType,
  MATCHING_POLICY,
  ResolutionDecision,
  type ContradictionEvidence,
} from '@resolve/contracts';

import {
  type CompanyFeatures,
  type FeatureExtractionResult,
  type PersonFeatures,
} from './features.js';

const SIGNAL_NAMES = ['email', 'phone', 'name', 'company', 'location'] as const;

export type ScoreSignalName = (typeof SIGNAL_NAMES)[number];
export type ScoreSignals = Record<ScoreSignalName, number | null>;
export type ScoreContributions = Record<ScoreSignalName, number>;

export interface ScoreExplanation {
  activeWeight: number;
  autoMatchBlocked: boolean;
  baseScore: number;
  contradictionPenalty: number;
  contributions: ScoreContributions;
  signals: ScoreSignals;
  thresholds: {
    autoMatch: number;
    review: number;
  };
  weights: Record<ScoreSignalName, number>;
}

export interface ScoringResult {
  algorithmVersion: string;
  decision: ResolutionDecision;
  explanation: ScoreExplanation;
  inputs: FeatureExtractionResult;
  score: number;
}

export function scoreFeatures(extraction: FeatureExtractionResult): ScoringResult {
  const signals =
    extraction.entityType === EntityType.Person
      ? personSignals(extraction.features)
      : companySignals(extraction.features);
  const weights = { ...MATCHING_POLICY.weights };
  const activeWeight = stableScore(
    SIGNAL_NAMES.reduce(
      (total, signalName) => total + (signals[signalName] === null ? 0 : weights[signalName]),
      0,
    ),
  );
  const contributions = Object.fromEntries(
    SIGNAL_NAMES.map((signalName) => {
      const signal = signals[signalName];
      const contribution = stableScore(
        signal === null || activeWeight === 0 ? 0 : (weights[signalName] * signal) / activeWeight,
      );
      return [signalName, contribution];
    }),
  ) as ScoreContributions;
  const baseScore = stableScore(
    clamp(SIGNAL_NAMES.reduce((total, signalName) => total + contributions[signalName], 0)),
  );
  const warningCount = extraction.contradictions.filter(
    ({ severity }) => severity === 'warning',
  ).length;
  const contradictionPenalty = stableScore(
    clamp(warningCount * MATCHING_POLICY.contradictions.warningPenalty),
  );
  const score = stableScore(clamp(baseScore - contradictionPenalty));
  const thresholdDecision = decide(score);
  const hasBlockingContradiction = extraction.contradictions.some(
    ({ severity }) => severity === 'blocking',
  );
  const autoMatchBlocked =
    MATCHING_POLICY.contradictions.blockAutoMatch &&
    hasBlockingContradiction &&
    thresholdDecision === ResolutionDecision.AutoMatch;
  const decision = autoMatchBlocked ? ResolutionDecision.Review : thresholdDecision;

  return {
    algorithmVersion: MATCHING_POLICY.version,
    score,
    decision,
    inputs: cloneInputs(extraction),
    explanation: {
      signals,
      weights,
      contributions,
      activeWeight,
      baseScore,
      contradictionPenalty,
      thresholds: { ...MATCHING_POLICY.thresholds },
      autoMatchBlocked,
    },
  };
}

function personSignals(features: PersonFeatures): ScoreSignals {
  return {
    email: positiveExact(features.email_exact),
    phone: positiveExact(features.phone_exact),
    name: strongest(features.name_edit_similarity, features.name_jaro_winkler_similarity),
    company: strongest(
      features.company_name_token_similarity,
      positiveExact(features.company_domain_exact),
    ),
    location: strongest(features.address_token_similarity, positiveExact(features.country_exact)),
  };
}

function companySignals(features: CompanyFeatures): ScoreSignals {
  return {
    email: positiveExact(features.email_exact),
    phone: positiveExact(features.phone_exact),
    name: strongest(
      features.company_name_edit_similarity,
      features.company_name_jaro_winkler_similarity,
      features.company_name_token_similarity,
    ),
    company: positiveExact(features.domain_exact),
    location: strongest(features.address_token_similarity, positiveExact(features.country_exact)),
  };
}

function positiveExact(value: boolean | null): number | null {
  return value === true ? 1 : null;
}

function strongest(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null).map(clamp);
  return present.length === 0 ? null : Math.max(...present);
}

function decide(score: number): ResolutionDecision {
  if (score >= MATCHING_POLICY.thresholds.autoMatch) return ResolutionDecision.AutoMatch;
  if (score >= MATCHING_POLICY.thresholds.review) return ResolutionDecision.Review;
  return ResolutionDecision.NoMatch;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function stableScore(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function cloneInputs(extraction: FeatureExtractionResult): FeatureExtractionResult {
  return {
    ...extraction,
    features: { ...extraction.features },
    contradictions: extraction.contradictions.map(cloneContradiction),
  } as FeatureExtractionResult;
}

function cloneContradiction(contradiction: ContradictionEvidence): ContradictionEvidence {
  return { ...contradiction };
}
