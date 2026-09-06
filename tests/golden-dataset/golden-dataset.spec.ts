import { readFileSync } from 'node:fs';

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
  readFileSync(new URL('./mvp-v1.json', import.meta.url), 'utf8'),
) as GoldenDataset;
const decisions = new Set(dataset.cases.map((testCase) => testCase.expected_decision));
const entityTypes = new Set(dataset.cases.map((testCase) => testCase.entity_type));

describe('MVP golden dataset', () => {
  it('contains stable, explained cases across both entity types and all decisions', () => {
    expect(dataset.version).toBe('mvp-v1');
    expect(dataset.cases.length).toBeGreaterThanOrEqual(8);
    expect(new Set(dataset.cases.map((testCase) => testCase.id)).size).toBe(dataset.cases.length);
    expect(entityTypes).toEqual(new Set(['person', 'company']));
    expect(decisions).toEqual(new Set(['AUTO_MATCH', 'REVIEW', 'NO_MATCH']));

    for (const testCase of dataset.cases) {
      expect(testCase.rationale.trim().length).toBeGreaterThan(0);
      expect(Object.keys(testCase.record_a).length).toBeGreaterThan(0);
      expect(Object.keys(testCase.record_b).length).toBeGreaterThan(0);
    }
  });
});
