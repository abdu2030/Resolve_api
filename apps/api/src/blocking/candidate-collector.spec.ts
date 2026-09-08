import { DatabaseEntityType } from '@resolve/database';

import { collectCandidates } from './candidate-collector.js';

describe('collectCandidates', () => {
  it('unions passes and accumulates evidence once per entity', () => {
    expect(
      collectCandidates(
        [
          {
            signal: 'EXACT_EMAIL',
            rows: [
              {
                entityId: 'entity-a',
                entityType: DatabaseEntityType.PERSON,
                supportingRecordId: 'record-a',
              },
            ],
          },
          {
            signal: 'EXACT_PHONE',
            rows: [
              {
                entityId: 'entity-a',
                entityType: DatabaseEntityType.PERSON,
                supportingRecordId: 'record-b',
              },
              {
                entityId: 'entity-b',
                entityType: DatabaseEntityType.PERSON,
                supportingRecordId: 'record-c',
              },
            ],
          },
        ],
        10,
      ),
    ).toEqual({
      candidates: [
        {
          entityId: 'entity-a',
          entityType: 'PERSON',
          matchedOn: ['EXACT_EMAIL', 'EXACT_PHONE'],
          supportingRecordIds: ['record-a', 'record-b'],
        },
        {
          entityId: 'entity-b',
          entityType: 'PERSON',
          matchedOn: ['EXACT_PHONE'],
          supportingRecordIds: ['record-c'],
        },
      ],
      truncated: false,
    });
  });

  it('deduplicates a supporting record repeated by different signals', () => {
    const row = {
      entityId: 'entity-a',
      entityType: DatabaseEntityType.COMPANY,
      supportingRecordId: 'record-a',
    };

    expect(
      collectCandidates(
        [
          { signal: 'COMPANY_DOMAIN', rows: [row] },
          { signal: 'NAME_LOCATION', rows: [row] },
        ],
        10,
      ).candidates[0],
    ).toEqual({
      entityId: 'entity-a',
      entityType: 'COMPANY',
      matchedOn: ['COMPANY_DOMAIN', 'NAME_LOCATION'],
      supportingRecordIds: ['record-a'],
    });
  });

  it('caps a single pass and reports its overflow row', () => {
    const result = collectCandidates(
      [
        {
          signal: 'EXACT_EMAIL',
          rows: ['a', 'b', 'c'].map((suffix) => ({
            entityId: 'entity-' + suffix,
            entityType: DatabaseEntityType.PERSON,
            supportingRecordId: 'record-' + suffix,
          })),
        },
      ],
      2,
    );

    expect(result.candidates.map(({ entityId }) => entityId)).toEqual(['entity-a', 'entity-b']);
    expect(result.truncated).toBe(true);
  });

  it('keeps first-pass order and reports cross-pass union overflow', () => {
    const result = collectCandidates(
      [
        {
          signal: 'EXACT_EMAIL',
          rows: [
            {
              entityId: 'entity-b',
              entityType: DatabaseEntityType.PERSON,
              supportingRecordId: 'record-b',
            },
            {
              entityId: 'entity-a',
              entityType: DatabaseEntityType.PERSON,
              supportingRecordId: 'record-a',
            },
          ],
        },
        {
          signal: 'EXACT_PHONE',
          rows: [
            {
              entityId: 'entity-c',
              entityType: DatabaseEntityType.PERSON,
              supportingRecordId: 'record-c',
            },
          ],
        },
      ],
      2,
    );

    expect(result).toMatchObject({
      candidates: [{ entityId: 'entity-b' }, { entityId: 'entity-a' }],
      truncated: true,
    });
  });
});
