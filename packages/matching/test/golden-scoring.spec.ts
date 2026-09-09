import 'reflect-metadata';

import { readFileSync } from 'node:fs';

import { EntityType } from '@resolve/contracts';
import { normalizeRecord } from '@resolve/normalization';

import { extractFeatures, scoreFeatures } from '../src/index.js';

interface GoldenCase {
  entity_type: 'person' | 'company';
  expected_decision: 'AUTO_MATCH' | 'REVIEW' | 'NO_MATCH';
  id: string;
  record_a: Record<string, unknown>;
  record_b: Record<string, unknown>;
}

interface GoldenDataset {
  cases: GoldenCase[];
}

const dataset = JSON.parse(
  readFileSync(new URL('../../../tests/golden-dataset/mvp-v1.json', import.meta.url), 'utf8'),
) as GoldenDataset;

describe('rules-0.1.0 golden decisions', () => {
  it.each(dataset.cases)('$id produces $expected_decision', (goldenCase) => {
    const entityType = goldenCase.entity_type === 'person' ? EntityType.Person : EntityType.Company;
    const left = normalizeRecord(goldenCase.entity_type, goldenCase.record_a);
    const right = normalizeRecord(goldenCase.entity_type, goldenCase.record_b);
    const features = extractFeatures(
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

    expect(scoreFeatures(features).decision).toBe(goldenCase.expected_decision);
  });
});
