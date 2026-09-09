import 'reflect-metadata';

import { EntityType } from '@resolve/contracts';

import { EntityTypeMismatchError, extractFeatures, type ComparisonRecord } from '../src/index.js';

const personLeft = {
  entityType: EntityType.Person,
  normalizedPayload: {
    name: 'martha',
    email: 'martha@example.com',
    phone: '+251911223344',
    company: { base: 'acme trading' },
    company_domain: 'acme.example',
    address: {
      line1: '10 bole road',
      city: 'addis ababa',
      postal_code: '1000',
      country: 'ET',
    },
  },
  rawPayload: {},
} satisfies ComparisonRecord;

const personRight = {
  entityType: EntityType.Person,
  normalizedPayload: {
    name: 'marhta',
    email: 'martha@example.com',
    phone: '+251911223344',
    company: { base: 'trading acme' },
    company_domain: 'acme.example',
    address: {
      line1: 'bole road 10',
      city: 'addis ababa',
      postal_code: '1000',
      country: 'ET',
    },
  },
  rawPayload: {},
} satisfies ComparisonRecord;

describe('extractFeatures', () => {
  it('extracts complete Person evidence from normalized fields', () => {
    const result = extractFeatures(personLeft, personRight);

    expect(result.featureVersion).toBe('features-v1');
    expect(result.entityType).toBe(EntityType.Person);
    if (result.entityType !== EntityType.Person) throw new Error('Expected Person features.');
    expect(result.features).toMatchObject({
      email_exact: true,
      phone_exact: true,
      company_name_token_similarity: 1,
      company_domain_exact: true,
      address_token_similarity: 1,
      country_exact: true,
    });
    expect(result.features.name_edit_similarity).toBeCloseTo(2 / 3, 10);
    expect(result.features.name_jaro_winkler_similarity).toBeCloseTo(0.961_111, 5);
    expect(result.contradictions).toEqual([]);
  });

  it('returns a stable null-filled Person feature shape for sparse records', () => {
    const sparseLeft = {
      entityType: EntityType.Person,
      normalizedPayload: {},
      rawPayload: {},
    } satisfies ComparisonRecord;
    const sparseRight = {
      entityType: EntityType.Person,
      normalizedPayload: { name: 'abdulkerim hassen' },
      rawPayload: {},
    } satisfies ComparisonRecord;

    expect(extractFeatures(sparseLeft, sparseRight)).toEqual({
      featureVersion: 'features-v1',
      entityType: EntityType.Person,
      features: {
        email_exact: null,
        phone_exact: null,
        name_edit_similarity: null,
        name_jaro_winkler_similarity: null,
        company_name_token_similarity: null,
        company_domain_exact: null,
        address_token_similarity: null,
        country_exact: null,
      },
      contradictions: [],
    });
  });

  it('extracts Company evidence using base names and prepared registration IDs', () => {
    const left = companyRecord({ registration_id: 'ET-1001' });
    const right = companyRecord(
      { registration_id: 'et-1001' },
      {
        name: { full: 'acme trading limited', base: 'acme trading' },
        address: { line1: 'bole road 10', city: 'addis ababa', country: 'ET' },
      },
    );

    expect(extractFeatures(left, right)).toEqual({
      featureVersion: 'features-v1',
      entityType: EntityType.Company,
      features: {
        email_exact: true,
        phone_exact: true,
        company_name_edit_similarity: 1,
        company_name_jaro_winkler_similarity: 1,
        company_name_token_similarity: 1,
        domain_exact: true,
        address_token_similarity: 1,
        country_exact: true,
        registration_id_exact: true,
      },
      contradictions: [],
    });
  });

  it.each([{}, { name: { base: 'acme trading' } }])(
    'returns a stable null-filled Company feature shape against sparse payload %p',
    (normalizedPayload) => {
      const sparse = {
        entityType: EntityType.Company,
        normalizedPayload: {},
        rawPayload: {},
      } satisfies ComparisonRecord;
      const other = { ...sparse, normalizedPayload };
      const expected = {
        featureVersion: 'features-v1',
        entityType: EntityType.Company,
        features: {
          email_exact: null,
          phone_exact: null,
          company_name_edit_similarity: null,
          company_name_jaro_winkler_similarity: null,
          company_name_token_similarity: null,
          domain_exact: null,
          address_token_similarity: null,
          country_exact: null,
          registration_id_exact: null,
        },
        contradictions: [],
      };

      expect(extractFeatures(sparse, other)).toEqual(expected);
      expect(extractFeatures(other, sparse)).toEqual(expected);
    },
  );

  it.each([
    ['NFKC', 'ＥＴ-１００１', 'et-1001'],
    ['outer whitespace', '\u2003 ET-1001 \t', 'et-1001'],
    ['Unicode whitespace collapse', 'ET\t\u2003 1001', 'et 1001'],
  ] as const)('prepares registration IDs using %s', (_, leftId, rightId) => {
    const left = companyRecord({ registration_id: leftId });
    const right = companyRecord({ registration_id: rightId });
    const result = extractFeatures(left, right);

    expect(result.features).toMatchObject({ registration_id_exact: true });
    expect(result.contradictions).toEqual([]);
    expect(left.rawPayload.registration_id).toBe(leftId);
    expect(right.rawPayload.registration_id).toBe(rightId);
  });

  it.each([
    ['ET-1001', 'ET1001'],
    ['ET/1001', 'ET-1001'],
    ['ET 1001', 'ET1001'],
  ] as const)(
    'preserves registration-ID punctuation and token structure for %s and %s',
    (leftId, rightId) => {
      const result = extractFeatures(
        companyRecord({ registration_id: leftId }),
        companyRecord({ registration_id: rightId }),
      );

      expect(result.features).toMatchObject({ registration_id_exact: false });
      expect(result.contradictions).toEqual([
        {
          code: 'REGISTRATION_ID_CONFLICT',
          field: 'registration_id',
          message: 'Both records contain different company registration identifiers.',
          severity: 'blocking',
        },
      ]);
    },
  );

  it('reports Person company-domain conflicts against the company_domain field', () => {
    const right = {
      ...personRight,
      normalizedPayload: { ...personRight.normalizedPayload, company_domain: 'other.example' },
    };

    expect(extractFeatures(personLeft, right).contradictions).toEqual([
      {
        code: 'COMPANY_DOMAIN_CONFLICT',
        field: 'company_domain',
        message: 'Both records contain different normalized company domain values.',
        severity: 'warning',
      },
    ]);
  });

  it('orders Company warnings before a blocking registration identifier conflict', () => {
    const left = companyRecord({ registration_id: 'ET-1001' });
    const right = companyRecord(
      { registration_id: 'ET-9009' },
      {
        email: 'other@example.com',
        phone: '+254700000001',
        domain: 'other.example',
        address: { line1: '20 waiyaki way', city: 'nairobi', country: 'KE' },
      },
    );

    const result = extractFeatures(left, right);

    expect(result.features).toMatchObject({
      email_exact: false,
      phone_exact: false,
      domain_exact: false,
      country_exact: false,
      registration_id_exact: false,
    });
    expect(result.contradictions).toEqual([
      {
        code: 'EMAIL_CONFLICT',
        field: 'email',
        message: 'Both records contain different normalized email values.',
        severity: 'warning',
      },
      {
        code: 'PHONE_CONFLICT',
        field: 'phone',
        message: 'Both records contain different normalized phone values.',
        severity: 'warning',
      },
      {
        code: 'COMPANY_DOMAIN_CONFLICT',
        field: 'domain',
        message: 'Both records contain different normalized company domain values.',
        severity: 'warning',
      },
      {
        code: 'COUNTRY_CONFLICT',
        field: 'address.country',
        message: 'Both records contain different country values.',
        severity: 'warning',
      },
      {
        code: 'REGISTRATION_ID_CONFLICT',
        field: 'registration_id',
        message: 'Both records contain different company registration identifiers.',
        severity: 'blocking',
      },
    ]);
  });

  it('treats malformed normalized payload fields as unavailable evidence', () => {
    const left = {
      entityType: EntityType.Person,
      normalizedPayload: {
        name: 42,
        email: ['not', 'a', 'string'],
        phone: { value: '+251911223344' },
        company: { base: false },
        company_domain: 1,
        address: 'not-an-address',
      },
      rawPayload: {},
    } satisfies ComparisonRecord;

    expect(extractFeatures(left, personRight).features).toEqual({
      email_exact: null,
      phone_exact: null,
      name_edit_similarity: null,
      name_jaro_winkler_similarity: null,
      company_name_token_similarity: null,
      company_domain_exact: null,
      address_token_similarity: null,
      country_exact: null,
    });
  });

  it('rejects mixed entity types without exposing record values', () => {
    const company = companyRecord({ registration_id: 'sensitive-identifier' });

    expect(() => extractFeatures(personLeft, company)).toThrow(EntityTypeMismatchError);
    expect(() => extractFeatures(personLeft, company)).toThrow(
      'Cannot extract features for mixed entity types: person and company.',
    );
    expect(() => extractFeatures(personLeft, company)).not.toThrow('sensitive-identifier');
  });

  it('does not mutate frozen input records or payloads', () => {
    const left = frozenPersonRecord('immutable-left@example.com');
    const right = frozenPersonRecord('immutable-right@example.com');
    const leftSnapshot = structuredClone(left);
    const rightSnapshot = structuredClone(right);

    extractFeatures(left, right);

    expect(left).toEqual(leftSnapshot);
    expect(right).toEqual(rightSnapshot);
  });
});

function companyRecord(
  rawPayload: Record<string, unknown>,
  normalizedOverrides: Record<string, unknown> = {},
): ComparisonRecord {
  return {
    entityType: EntityType.Company,
    normalizedPayload: {
      name: { full: 'acme trading plc', base: 'acme trading' },
      email: 'office@acme.example',
      phone: '+251911223344',
      domain: 'acme.example',
      address: { line1: '10 bole road', city: 'addis ababa', country: 'ET' },
      ...normalizedOverrides,
    },
    rawPayload,
  };
}

function frozenPersonRecord(email: string): ComparisonRecord {
  const address = Object.freeze({ city: 'addis ababa', country: 'ET' });
  const company = Object.freeze({ base: 'acme trading' });
  const normalizedPayload = Object.freeze({
    name: 'abdulkerim hassen',
    email,
    phone: '+251911223344',
    company,
    company_domain: 'acme.example',
    address,
  });

  return Object.freeze({
    entityType: EntityType.Person,
    normalizedPayload,
    rawPayload: Object.freeze({}),
  });
}
