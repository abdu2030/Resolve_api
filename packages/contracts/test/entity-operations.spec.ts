import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as contracts from '../src/index.js';

const id = 'A1111111-1111-4111-8111-111111111111';
const otherId = 'b2222222-2222-4222-8222-222222222222';
const exports = contracts as unknown as Record<string, new () => object>;
const merge = {
  source_entity_id: id,
  expected_source_version: 0,
  expected_target_version: 2147483647,
  reason: '  Confirmed duplicate  ',
};
const split = { record_ids: [id], expected_version: 1, reason: '  Separate identity  ' };

async function check(
  name: string,
  payload: object,
): Promise<{ instance: object; errors: unknown[] }> {
  expect(exports[name]).toBeDefined();
  const instance = plainToInstance(exports[name]!, payload);
  return {
    instance,
    errors: await validate(instance, { whitelist: true, forbidNonWhitelisted: true }),
  };
}

describe('entity operation request contracts', () => {
  it('accepts merge and normalizes UUID/reason before execution', async () => {
    const { instance, errors } = await check('MergeEntityDto', merge);
    expect(errors).toEqual([]);
    expect(instance).toMatchObject({
      source_entity_id: id.toLowerCase(),
      reason: 'Confirmed duplicate',
    });
  });

  it('accepts selected-record split and explicit merge reversal', async () => {
    const selected = await check('SplitEntityDto', split);
    expect(selected.errors).toEqual([]);
    expect(selected.instance).toMatchObject({
      record_ids: [id.toLowerCase()],
      reason: 'Separate identity',
    });
    const reversal = await check('SplitEntityDto', {
      merge_event_id: id,
      expected_version: 0,
      reason: 'Reverse',
    });
    expect(reversal.errors).toEqual([]);
    expect(reversal.instance).toMatchObject({ merge_event_id: id.toLowerCase() });
  });

  it.each([
    {},
    { record_ids: [id], merge_event_id: otherId },
    { record_ids: null },
    { merge_event_id: null },
    { record_ids: [id], merge_event_id: null },
    { record_ids: null, merge_event_id: id },
    { record_ids: [] },
    { record_ids: [id, id.toLowerCase()] },
    { record_ids: ['bad'] },
    { merge_event_id: 'bad' },
    {
      record_ids: Array.from(
        { length: 1001 },
        (_, index) => `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`,
      ),
    },
    { record_ids: 'bad' },
  ])('rejects invalid or ambiguous split selectors: %j', async (selectors) => {
    const { errors } = await check('SplitEntityDto', {
      expected_version: 1,
      reason: 'Split',
      ...selectors,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts the maximum selected-record array', async () => {
    const ids = Array.from(
      { length: 1000 },
      (_, index) => `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`,
    );
    expect((await check('SplitEntityDto', { ...split, record_ids: ids })).errors).toEqual([]);
  });

  it('rejects the internal selector property as an unknown client field', async () => {
    const { errors } = await check('SplitEntityDto', {
      ...split,
      selectorRequirement: 'extra',
    });
    expect(errors).toMatchObject([
      {
        property: 'selectorRequirement',
        constraints: { whitelistValidation: 'property selectorRequirement should not exist' },
      },
    ]);
  });

  it.each([
    ['basic', 'x'],
    ['supplementary', '\u{1f600}'],
  ])(
    'accepts 500 and rejects 501 %s reason characters after trimming',
    async (_name, character) => {
      const reason = character.repeat(500);
      for (const [name, payload] of [
        ['MergeEntityDto', merge],
        ['SplitEntityDto', split],
      ] as const) {
        const accepted = await check(name, { ...payload, reason: `  ${reason}  ` });
        expect(accepted.errors).toEqual([]);
        expect(accepted.instance).toMatchObject({ reason });
        expect(
          (await check(name, { ...payload, reason: reason + character })).errors,
        ).toMatchObject([{ property: 'reason' }]);
      }
    },
  );

  it.each(['', '   ', null, 10, 'x'.repeat(501)])('rejects invalid reasons %j', async (reason) => {
    expect((await check('MergeEntityDto', { ...merge, reason })).errors.length).toBeGreaterThan(0);
    expect((await check('SplitEntityDto', { ...split, reason })).errors.length).toBeGreaterThan(0);
  });

  it.each(['1', 0.5, -1, 2147483648, null, undefined])(
    'rejects non-PostgreSQL versions %j',
    async (version) => {
      expect(
        (await check('MergeEntityDto', { ...merge, expected_source_version: version })).errors
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await check('MergeEntityDto', { ...merge, expected_target_version: version })).errors
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await check('SplitEntityDto', { ...split, expected_version: version })).errors.length,
      ).toBeGreaterThan(0);
    },
  );

  it('rejects unknown fields and malformed source IDs', async () => {
    expect(
      (await check('MergeEntityDto', { ...merge, tenant_id: id })).errors.length,
    ).toBeGreaterThan(0);
    expect(
      (await check('SplitEntityDto', { ...split, tenant_id: id })).errors.length,
    ).toBeGreaterThan(0);
    expect(
      (await check('MergeEntityDto', { ...merge, source_entity_id: 'bad' })).errors.length,
    ).toBeGreaterThan(0);
  });
});
