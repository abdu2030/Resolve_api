export const MATCHING_POLICY = {
  version: 'rules-0.1.0',
  weights: {
    email: 0.4,
    phone: 0.25,
    name: 0.2,
    company: 0.1,
    location: 0.05,
  },
  thresholds: {
    autoMatch: 0.92,
    review: 0.72,
  },
  contradictions: {
    warningPenalty: 0.15,
    blockAutoMatch: true,
  },
} as const;
