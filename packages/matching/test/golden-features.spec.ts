import 'reflect-metadata';

import { readFileSync } from 'node:fs';

import { EntityType } from '@resolve/contracts';
import { normalizeRecord } from '@resolve/normalization';

import { extractFeatures, type FeatureExtractionResult } from '../src/index.js';

interface GoldenCase {
  entity_type: 'person' | 'company';
  expected_decision: 'AUTO_MATCH' | 'REVIEW' | 'NO_MATCH';
  id: string;
  rationale: string;
  record_a: Record<string, unknown>;
  record_b: Record<string, unknown>;
}

interface GoldenDataset {
  cases: GoldenCase[];
  version: string;
}

const dataset = JSON.parse(
  readFileSync(new URL('../../../tests/golden-dataset/mvp-v1.json', import.meta.url), 'utf8'),
) as GoldenDataset;

describe('features-v1 golden evidence', () => {
  it('recognizes equivalent Person email and Ethiopian phone formats', () => {
    const result = extractGoldenFeatures('person-email-phone-format-auto-match');

    expect(result.features).toMatchObject({ email_exact: true, phone_exact: true });
    expect(result.contradictions).toEqual([]);
  });

  it('preserves exact Person name evidence while warning on conflicting contacts', () => {
    const result = extractGoldenFeatures('person-shared-name-no-match');

    expect(result.features).toMatchObject({ name_jaro_winkler_similarity: 1 });
    expect(result.contradictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EMAIL_CONFLICT', severity: 'warning' }),
        expect.objectContaining({ code: 'PHONE_CONFLICT', severity: 'warning' }),
      ]),
    );
  });

  it('recognizes equivalent Company base names and domains', () => {
    const result = extractGoldenFeatures('company-abbreviation-domain-auto-match');

    expect(result.features).toMatchObject({
      company_name_token_similarity: 1,
      domain_exact: true,
    });
  });

  it('blocks on conflicting Company registration identifiers', () => {
    const result = extractGoldenFeatures('company-registration-conflict-review');

    expect(result.features).toMatchObject({ registration_id_exact: false });
    expect(result.contradictions).toContainEqual(
      expect.objectContaining({ code: 'REGISTRATION_ID_CONFLICT', severity: 'blocking' }),
    );
  });

  it('warns on conflicting Company domains and countries', () => {
    const result = extractGoldenFeatures('company-common-name-country-no-match');

    expect(result.contradictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'COMPANY_DOMAIN_CONFLICT', severity: 'warning' }),
        expect.objectContaining({ code: 'COUNTRY_CONFLICT', severity: 'warning' }),
      ]),
    );
  });
});

function extractGoldenFeatures(id: string): FeatureExtractionResult {
  const goldenCase = dataset.cases.find((candidate) => candidate.id === id);
  if (goldenCase === undefined) throw new Error(`Missing golden case: ${id}`);

  const entityType = goldenCase.entity_type === 'person' ? EntityType.Person : EntityType.Company;
  const left = normalizeRecord(goldenCase.entity_type, goldenCase.record_a);
  const right = normalizeRecord(goldenCase.entity_type, goldenCase.record_b);

  return extractFeatures(
    {
      entityType,
      normalizedPayload: left.normalized_payload,
      rawPayload: goldenCase.record_a,
    },
    {
      entityType,
      normalizedPayload: right.normalized_payload,
      rawPayload: goldenCase.record_b,
    },
  );
}
