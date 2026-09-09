export { presentString, type ComparableString } from './comparable-string.js';
export { exactEquality } from './exact.js';
export { editSimilarity } from './edit-similarity.js';
export { jaroWinklerSimilarity } from './jaro-winkler.js';
export { tokenSimilarity } from './token-similarity.js';
export { domainEquality } from './domain.js';
export { addressCountryEquality, addressTokenSimilarity } from './address.js';
export { EntityTypeMismatchError } from './entity-type-mismatch.error.js';
export { extractFeatures } from './feature-extractor.js';
export {
  FEATURE_VERSION,
  type CompanyFeatures,
  type ComparisonRecord,
  type FeatureExtractionResult,
  type PersonFeatures,
} from './features.js';
export {
  scoreFeatures,
  type ScoreContributions,
  type ScoreExplanation,
  type ScoreSignals,
  type ScoreSignalName,
  type ScoringResult,
} from './scoring.js';
