import 'reflect-metadata';

import {
  EntityType,
  MATCHING_POLICY,
  ResolutionDecision,
  type ContradictionEvidence,
} from '@resolve/contracts';

import {
  FEATURE_VERSION,
  scoreFeatures,
  type FeatureExtractionResult,
  type PersonFeatures,
} from '../src/index.js';

const EMPTY_PERSON_FEATURES: PersonFeatures = {
  email_exact: null,
  phone_exact: null,
  name_edit_similarity: null,
  name_jaro_winkler_similarity: null,
  company_name_token_similarity: null,
  company_domain_exact: null,
  address_token_similarity: null,
  country_exact: null,
};

describe('scoreFeatures', () => {
  it.each([
    [0.919_999, ResolutionDecision.Review],
    [0.92, ResolutionDecision.AutoMatch],
    [0.72, ResolutionDecision.Review],
    [0.719_999, ResolutionDecision.NoMatch],
  ] as const)('applies the three-way decision at score %s', (similarity, decision) => {
    const result = scoreFeatures(
      personExtraction({
        name_edit_similarity: similarity,
        name_jaro_winkler_similarity: similarity,
      }),
    );

    expect(result.score).toBeCloseTo(similarity, 10);
    expect(result.decision).toBe(decision);
    expect(result.algorithmVersion).toBe(MATCHING_POLICY.version);
    expect(result.explanation.thresholds).toEqual(MATCHING_POLICY.thresholds);
  });

  it('renormalizes weights across available positive evidence', () => {
    const result = scoreFeatures(
      personExtraction({
        email_exact: true,
        name_edit_similarity: 0.8,
        name_jaro_winkler_similarity: 0.8,
      }),
    );

    expect(result.explanation.activeWeight).toBeCloseTo(0.6, 10);
    expect(result.explanation.signals).toEqual({
      email: 1,
      phone: null,
      name: 0.8,
      company: null,
      location: null,
    });
    expect(result.explanation.contributions.email).toBeCloseTo(2 / 3, 10);
    expect(result.explanation.contributions.phone).toBe(0);
    expect(result.explanation.contributions.name).toBeCloseTo(4 / 15, 10);
    expect(result.explanation.contributions.company).toBe(0);
    expect(result.explanation.contributions.location).toBe(0);
    expect(result.explanation.baseScore).toBeCloseTo(14 / 15, 10);
  });

  it('reduces confidence once for each warning contradiction', () => {
    const oneWarning = scoreFeatures(
      personExtraction(
        {
          email_exact: true,
          phone_exact: true,
          name_edit_similarity: 1,
          name_jaro_winkler_similarity: 1,
          country_exact: false,
        },
        [warning('COUNTRY_CONFLICT')],
      ),
    );
    const twoWarnings = scoreFeatures(
      personExtraction(
        {
          email_exact: true,
          phone_exact: true,
          name_edit_similarity: 1,
          name_jaro_winkler_similarity: 1,
          country_exact: false,
        },
        [warning('COUNTRY_CONFLICT'), warning('EMAIL_CONFLICT')],
      ),
    );

    expect(oneWarning.explanation.contradictionPenalty).toBe(0.15);
    expect(oneWarning.score).toBe(0.85);
    expect(oneWarning.decision).toBe(ResolutionDecision.Review);
    expect(twoWarnings.explanation.contradictionPenalty).toBe(0.3);
    expect(twoWarnings.score).toBe(0.7);
    expect(twoWarnings.decision).toBe(ResolutionDecision.NoMatch);
  });

  it('blocks AUTO_MATCH when a blocking contradiction is present', () => {
    const result = scoreFeatures(
      personExtraction(
        {
          email_exact: true,
          phone_exact: true,
          name_edit_similarity: 1,
          name_jaro_winkler_similarity: 1,
        },
        [blocking('REGISTRATION_ID_CONFLICT')],
      ),
    );

    expect(result.score).toBe(1);
    expect(result.decision).toBe(ResolutionDecision.Review);
    expect(result.explanation.autoMatchBlocked).toBe(true);
  });

  it('keeps a blocking contradiction as NO_MATCH below the review threshold', () => {
    const result = scoreFeatures(
      personExtraction(
        {
          name_edit_similarity: 0.5,
          name_jaro_winkler_similarity: 0.5,
        },
        [blocking('REGISTRATION_ID_CONFLICT')],
      ),
    );

    expect(result.score).toBe(0.5);
    expect(result.decision).toBe(ResolutionDecision.NoMatch);
    expect(result.explanation.autoMatchBlocked).toBe(false);
  });

  it('clamps penalties at zero and stores independent score inputs', () => {
    const extraction = personExtraction(
      {
        name_edit_similarity: 0.2,
        name_jaro_winkler_similarity: 0.2,
      },
      [
        warning('EMAIL_CONFLICT'),
        warning('PHONE_CONFLICT'),
        warning('COMPANY_DOMAIN_CONFLICT'),
        warning('COUNTRY_CONFLICT'),
      ],
    );
    const result = scoreFeatures(extraction);

    extraction.features.name_edit_similarity = 1;
    extraction.contradictions[0]!.code = 'CHANGED';

    expect(result.score).toBe(0);
    expect(result.inputs).toEqual({
      featureVersion: FEATURE_VERSION,
      entityType: EntityType.Person,
      features: {
        ...EMPTY_PERSON_FEATURES,
        name_edit_similarity: 0.2,
        name_jaro_winkler_similarity: 0.2,
      },
      contradictions: [
        warning('EMAIL_CONFLICT'),
        warning('PHONE_CONFLICT'),
        warning('COMPANY_DOMAIN_CONFLICT'),
        warning('COUNTRY_CONFLICT'),
      ],
    });
  });

  it('returns zero with a null-filled explanation when no evidence exists', () => {
    const result = scoreFeatures(personExtraction());

    expect(result.score).toBe(0);
    expect(result.decision).toBe(ResolutionDecision.NoMatch);
    expect(result.explanation.activeWeight).toBe(0);
    expect(result.explanation.baseScore).toBe(0);
    expect(result.explanation.signals).toEqual({
      email: null,
      phone: null,
      name: null,
      company: null,
      location: null,
    });
  });
});

function personExtraction(
  overrides: Partial<PersonFeatures> = {},
  contradictions: ContradictionEvidence[] = [],
): Extract<FeatureExtractionResult, { entityType: EntityType.Person }> {
  return {
    featureVersion: FEATURE_VERSION,
    entityType: EntityType.Person,
    features: { ...EMPTY_PERSON_FEATURES, ...overrides },
    contradictions,
  };
}

function warning(code: string): ContradictionEvidence {
  return { code, message: code, severity: 'warning' };
}

function blocking(code: string): ContradictionEvidence {
  return { code, message: code, severity: 'blocking' };
}
