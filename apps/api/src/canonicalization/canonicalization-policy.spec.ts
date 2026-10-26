import { EntityType } from '@resolve/contracts';

import { CanonicalizationDataIntegrityError } from './canonicalization-data-integrity.error.js';
import { buildCanonicalProjection } from './canonicalization-policy.js';
import type { CanonicalizationRecord } from './canonicalization.types.js';

function record(overrides: Partial<CanonicalizationRecord> = {}): CanonicalizationRecord {
  return {
    id: 'record-default',
    externalId: 'external-default',
    updatedAt: new Date('2026-09-09T10:00:00.000Z'),
    rawPayload: {},
    normalizedPayload: {},
    normalizationVersion: 'normalization-v1',
    source: { id: 'source-default', name: 'Default source', priority: 100 },
    ...overrides,
  };
}

describe('buildCanonicalProjection', () => {
  it('uses the lower-priority source and keeps a cleaned raw person name', () => {
    const projection = buildCanonicalProjection(EntityType.Person, [
      record({
        id: 'record-low-authority',
        rawPayload: { name: 'Low Authority' },
        normalizedPayload: { name: 'low authority' },
        source: { id: 'source-low', name: 'CSV Import', priority: 100 },
      }),
      record({
        id: 'record-high-authority',
        externalId: 'crm-123',
        rawPayload: { name: '  Abdulkerim   Hassen  ' },
        normalizedPayload: { name: 'abdulkerim hassen' },
        source: { id: 'source-high', name: 'Verified CRM', priority: 10 },
      }),
    ]);

    expect(projection.canonicalData).toEqual({ name: 'Abdulkerim Hassen' });
    expect(projection.fields).toEqual([
      expect.objectContaining({
        fieldPath: 'name',
        canonicalValue: 'Abdulkerim Hassen',
        rawValue: '  Abdulkerim   Hassen  ',
        sourceRecordId: 'record-high-authority',
        sourceSystemId: 'source-high',
        sourceSystemName: 'Verified CRM',
        externalId: 'crm-123',
        sourcePriority: 10,
        selectionRule: 'SOURCE_PRIORITY',
        completenessScore: 17,
        normalizationVersion: 'normalization-v1',
        canonicalizationVersion: 'canonicalization-v1',
      }),
    ]);
  });

  it('uses normalized values for person email, phone, and company domain', () => {
    const projection = buildCanonicalProjection(EntityType.Person, [
      record({
        rawPayload: {
          email: 'User@EXAMPLE.COM',
          phone: '0911 223 344',
          company_domain: 'ACME.EXAMPLE',
        },
        normalizedPayload: {
          email: 'User@example.com',
          phone: '+251911223344',
          company_domain: 'acme.example',
        },
      }),
    ]);

    expect(projection.canonicalData).toEqual({
      email: 'User@example.com',
      phone: '+251911223344',
      company_domain: 'acme.example',
    });
    expect(projection.fields.map((field) => [field.fieldPath, field.rawValue])).toEqual([
      ['email', 'User@EXAMPLE.COM'],
      ['phone', '0911 223 344'],
      ['company_domain', 'ACME.EXAMPLE'],
    ]);
  });

  it.each([
    [
      'COMPLETENESS',
      [
        record({
          id: 'record-short',
          rawPayload: { name: 'Ana' },
          normalizedPayload: { name: 'ana' },
          source: { id: 'source-a', name: 'System A', priority: 10 },
        }),
        record({
          id: 'record-long',
          rawPayload: { name: 'Abdulkerim Hassen' },
          normalizedPayload: { name: 'abdulkerim hassen' },
          source: { id: 'source-b', name: 'System B', priority: 10 },
        }),
      ],
      'record-long',
    ],
    [
      'RECENCY',
      [
        record({
          id: 'record-old',
          updatedAt: new Date('2026-09-08T10:00:00.000Z'),
          rawPayload: { name: 'Same' },
          normalizedPayload: { name: 'same' },
          source: { id: 'source-a', name: 'System A', priority: 10 },
        }),
        record({
          id: 'record-new',
          updatedAt: new Date('2026-09-09T10:00:00.000Z'),
          rawPayload: { name: 'SAME' },
          normalizedPayload: { name: 'same' },
          source: { id: 'source-b', name: 'System B', priority: 10 },
        }),
      ],
      'record-new',
    ],
    [
      'STABLE_TIE_BREAK',
      [
        record({
          id: 'record-b',
          rawPayload: { name: 'Same' },
          normalizedPayload: { name: 'same' },
          source: { id: 'source-a', name: 'System A', priority: 10 },
        }),
        record({
          id: 'record-a',
          rawPayload: { name: 'SAME' },
          normalizedPayload: { name: 'same' },
          source: { id: 'source-b', name: 'System B', priority: 10 },
        }),
      ],
      'record-a',
    ],
  ])('selects person name by %s', (rule, records, sourceRecordId) => {
    const field = buildCanonicalProjection(EntityType.Person, records).fields[0];

    expect(field).toMatchObject({ selectionRule: rule, sourceRecordId });
  });

  it('selects each address component independently with nested provenance', () => {
    const projection = buildCanonicalProjection(EntityType.Person, [
      record({
        id: 'record-line1',
        rawPayload: { address: { line1: ' 12   Bole Road ' } },
        normalizedPayload: { address: { line1: '12 bole road' } },
      }),
      record({
        id: 'record-city',
        rawPayload: { address: { city: ' Addis   Ababa ' } },
        normalizedPayload: { address: { city: 'addis ababa' } },
      }),
      record({
        id: 'record-region',
        rawPayload: { address: { region: ' Addis Ababa ' } },
        normalizedPayload: { address: { region: 'addis ababa' } },
      }),
      record({
        id: 'record-postal',
        rawPayload: { address: { postal_code: ' 1000 ' } },
        normalizedPayload: { address: { postal_code: '1000' } },
      }),
    ]);

    expect(projection.canonicalData).toEqual({
      address: {
        line1: '12 Bole Road',
        city: 'Addis Ababa',
        region: 'Addis Ababa',
        postal_code: '1000',
      },
    });
    expect(projection.provenance).toMatchObject({
      address: {
        line1: { sourceRecordId: 'record-line1' },
        city: { sourceRecordId: 'record-city' },
        region: { sourceRecordId: 'record-region' },
        postal_code: { sourceRecordId: 'record-postal' },
      },
    });
  });

  it('uses company full normalized name length and raw registration display text', () => {
    const projection = buildCanonicalProjection(EntityType.Company, [
      record({
        rawPayload: {
          name: '  Acme   Trading PLC  ',
          domain: 'ACME.EXAMPLE',
          registration_id: ' REG-123 ',
          address: { country: 'et' },
        },
        normalizedPayload: {
          name: { full: 'acme trading plc', base: 'acme trading', legal_suffix: 'plc' },
          domain: 'acme.example',
          address: { country: 'ET' },
        },
      }),
    ]);

    expect(projection.canonicalData).toEqual({
      name: 'Acme Trading PLC',
      domain: 'acme.example',
      registration_id: 'REG-123',
      address: { country: 'ET' },
    });
    expect(projection.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldPath: 'name', completenessScore: 16 }),
        expect.objectContaining({ fieldPath: 'registration_id', completenessScore: 7 }),
      ]),
    );
  });

  it('uses the normalized full company name for a person company field', () => {
    const projection = buildCanonicalProjection(EntityType.Person, [
      record({
        rawPayload: { company: ' Acme   Trading PLC ' },
        normalizedPayload: {
          company: { full: 'acme trading plc', base: 'acme trading', legal_suffix: 'plc' },
        },
      }),
    ]);

    expect(projection.canonicalData).toEqual({ company: 'Acme Trading PLC' });
    expect(projection.fields[0]).toMatchObject({ completenessScore: 16 });
  });

  it('counts Unicode code points for display completeness', () => {
    const field = buildCanonicalProjection(EntityType.Person, [
      record({
        rawPayload: { name: '😀😀' },
        normalizedPayload: { name: '😀😀' },
      }),
    ]).fields[0];

    expect(field).toMatchObject({ canonicalValue: '😀😀', completenessScore: 2 });
  });

  it('does not emit null, missing, empty, or whitespace-only values', () => {
    const projection = buildCanonicalProjection(EntityType.Person, [
      record({
        rawPayload: { name: ' ', email: null, address: { city: '   ' } },
        normalizedPayload: { name: '', email: null, address: { city: '' } },
      }),
    ]);

    expect(projection).toEqual({ canonicalData: {}, provenance: {}, fields: [] });
  });

  it('rejects a malformed stored normalized object', () => {
    expect(() =>
      buildCanonicalProjection(EntityType.Person, [
        record({ normalizedPayload: [] as unknown as Record<string, unknown> }),
      ]),
    ).toThrow(CanonicalizationDataIntegrityError);
  });

  it('rejects malformed normalized fields even when no raw candidate uses them', () => {
    expect(() =>
      buildCanonicalProjection(EntityType.Person, [
        record({
          rawPayload: {},
          normalizedPayload: { name: { full: 'not a person name' }, address: [] },
        }),
      ]),
    ).toThrow(CanonicalizationDataIntegrityError);
  });

  it('rejects a scalar company name normalization', () => {
    expect(() =>
      buildCanonicalProjection(EntityType.Company, [
        record({
          rawPayload: { name: 'Acme Trading PLC' },
          normalizedPayload: { name: 'acme trading plc' },
        }),
      ]),
    ).toThrow(CanonicalizationDataIntegrityError);
  });

  it('rejects malformed structured company-name normalization fields', () => {
    expect(() =>
      buildCanonicalProjection(EntityType.Company, [
        record({
          rawPayload: { name: 'Acme Trading PLC' },
          normalizedPayload: {
            name: { full: 'acme trading plc', base: 42, legal_suffix: [] },
          },
        }),
      ]),
    ).toThrow(CanonicalizationDataIntegrityError);
  });

  it.each([
    [
      EntityType.Person,
      [
        record({
          id: 'record-b',
          rawPayload: { name: 'Berta', email: 'BERTA@EXAMPLE.COM' },
          normalizedPayload: { name: 'berta', email: 'Berta@example.com' },
          source: { id: 'source-b', name: 'Source B', priority: 20 },
        }),
        record({
          id: 'record-a',
          rawPayload: { name: '  Berta  ', phone: '0911 223 344' },
          normalizedPayload: { name: 'berta', phone: '+251911223344' },
          source: { id: 'source-a', name: 'Source A', priority: 10 },
        }),
      ],
    ],
    [
      EntityType.Company,
      [
        record({
          id: 'record-b',
          rawPayload: { name: 'Acme Ltd', registration_id: 'REG-1' },
          normalizedPayload: {
            name: { full: 'acme ltd', base: 'acme', legal_suffix: 'ltd' },
          },
          source: { id: 'source-b', name: 'Source B', priority: 20 },
        }),
        record({
          id: 'record-a',
          rawPayload: { name: 'Acme Limited', domain: 'ACME.EXAMPLE' },
          normalizedPayload: {
            name: { full: 'acme limited', base: 'acme', legal_suffix: 'limited' },
            domain: 'acme.example',
          },
          source: { id: 'source-a', name: 'Source A', priority: 10 },
        }),
      ],
    ],
  ])('is deterministic when %s records arrive in a different order', (entityType, records) => {
    expect(buildCanonicalProjection(entityType, records)).toEqual(
      buildCanonicalProjection(entityType, [...records].reverse()),
    );
  });
});
