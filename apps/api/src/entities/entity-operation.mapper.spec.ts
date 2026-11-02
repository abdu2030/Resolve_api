import { EntityDataIntegrityError } from './entity-data-integrity.error.js';
import { mapEntityOperation } from './entity-operation.mapper.js';

const row: Parameters<typeof mapEntityOperation>[0] = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  type: 'MERGE',
  operationVersion: 'entity-operations-v1',
  sourceEntityId: '33333333-3333-4333-8333-333333333333',
  targetEntityId: '44444444-4444-4444-8444-444444444444',
  recordIds: ['55555555-5555-4555-8555-555555555555'],
  reason: 'Confirmed duplicate',
  actorApiKeyId: '66666666-6666-4666-8666-666666666666',
  sourceVersionBefore: 1,
  sourceVersionAfter: 2,
  targetVersionBefore: 1,
  targetVersionAfter: 2,
  reversedOperationId: null,
  createdAt: new Date('2026-11-02T00:00:00.000Z'),
};

describe('entity operation reason mapping', () => {
  it.each([
    ['500 basic characters', 'x'.repeat(500)],
    ['251 supplementary characters', '\u{1f600}'.repeat(251)],
    ['500 supplementary characters', '\u{1f600}'.repeat(500)],
    ['500 mixed characters', 'x'.repeat(499) + '\u{1f600}'],
  ])('preserves %s', (_description, reason) => {
    expect(mapEntityOperation({ ...row, reason })).toMatchObject({ reason });
  });

  it.each([
    ['501 basic characters', 'x'.repeat(501)],
    ['501 supplementary characters', '\u{1f600}'.repeat(501)],
    ['501 mixed characters', 'x'.repeat(500) + '\u{1f600}'],
    ['empty reason', ''],
    ['whitespace-only reason', '   '],
  ])('rejects %s', (_description, reason) => {
    expect(() => mapEntityOperation({ ...row, reason })).toThrow(EntityDataIntegrityError);
  });
});
