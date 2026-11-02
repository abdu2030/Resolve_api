import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReviewDecisionDto, ReviewListQueryDto } from '../src/index.js';

const valid = {
  decision: 'APPROVE',
  reason: ' Confirmed ',
  expected_source_version: 1,
  expected_candidate_version: 0,
};
async function errors(value: object): Promise<unknown[]> {
  return validate(plainToInstance(ReviewDecisionDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}
describe('review contracts', () => {
  it('accepts human outcomes and trims a Unicode reason', async () => {
    for (const decision of ['APPROVE', 'REJECT']) {
      const instance = plainToInstance(ReviewDecisionDto, {
        ...valid,
        decision,
        reason: ` ${'😀'.repeat(500)} `,
      });
      expect(await validate(instance)).toEqual([]);
      expect(instance.reason).toHaveLength(1000);
    }
  });
  it.each([
    { decision: 'MATCH' },
    { reason: '' },
    { reason: '  ' },
    { reason: null },
    { reason: '😀'.repeat(501) },
    { expected_source_version: 0 },
    { expected_source_version: '1' },
    { expected_source_version: 1.5 },
    { expected_candidate_version: null },
    { expected_candidate_version: -1 },
    { expected_candidate_version: 2147483648 },
    { tenant_id: 'untrusted' },
    { actor_api_key_id: 'untrusted' },
    { expected_source_version: undefined },
  ])('rejects invalid decision payload %p', async (change) => {
    expect(await errors({ ...valid, ...change })).not.toEqual([]);
  });
  it('validates bounded query parameters and rejects null/unknown fields', async () => {
    expect(
      await validate(plainToInstance(ReviewListQueryDto, { status: 'RESOLVED', limit: '100' })),
    ).toEqual([]);
    for (const value of [
      { status: null },
      { limit: 101 },
      { cursor: null },
      { status: 'ALL' },
      { tenant_id: 'other' },
    ]) {
      expect(
        await validate(plainToInstance(ReviewListQueryDto, value), {
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      ).not.toEqual([]);
    }
  });
});
