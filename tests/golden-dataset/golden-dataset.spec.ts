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
  it('has independent, explained synthetic identity labels for every pair', () => {
    const quality = JSON.parse(
      readFileSync(new URL('./quality-v1.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
      dataset_version: string;
      label_origin: string;
      cases: Array<{
        id: string;
        same_identity: boolean;
        identity_rationale: string;
        expected_pipeline_decision: string;
        expected_candidate_count: number;
      }>;
    };
    expect(quality.version).toBe('quality-v1');
    expect(quality.dataset_version).toBe(dataset.version);
    expect(quality.label_origin).toContain('synthetic');
    expect(quality.cases).toHaveLength(dataset.cases.length);
    expect(new Set(quality.cases.map((item) => item.id))).toEqual(
      new Set(dataset.cases.map((item) => item.id)),
    );
    for (const label of quality.cases) {
      expect(typeof label.same_identity).toBe('boolean');
      expect(label.identity_rationale.trim().length).toBeGreaterThan(0);
      expect(
        decisions.has(label.expected_pipeline_decision as GoldenCase['expected_decision']),
      ).toBe(true);
      expect([0, 1]).toContain(label.expected_candidate_count);
    }
    expect(quality.cases.some((item) => item.same_identity)).toBe(true);
    expect(quality.cases.some((item) => !item.same_identity)).toBe(true);
  });

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
