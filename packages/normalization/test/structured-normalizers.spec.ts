import { normalizeAddress, normalizeCompanyName, normalizeRecord } from '../src/index.js';

describe('company-name normalization', () => {
  it('retains the full company name and separates a terminal legal suffix', () => {
    expect(normalizeCompanyName(' Acme Trading PLC ')).toEqual({
      full: 'acme trading plc',
      base: 'acme trading',
      legal_suffix: 'plc',
    });
  });

  it.each([
    ['Ltd.', 'ltd'],
    ['LIMITED', 'limited'],
    ['llc', 'llc'],
    ['Inc.', 'inc'],
    ['incorporated', 'incorporated'],
    ['Corp.', 'corp'],
    ['corporation', 'corporation'],
    ['Co.', 'co'],
    ['company', 'company'],
  ])('recognizes %s as the %s legal suffix', (rawSuffix, expectedSuffix) => {
    expect(normalizeCompanyName(`Example ${rawSuffix}`)).toEqual({
      full: `example ${rawSuffix.toLowerCase()}`,
      base: 'example',
      legal_suffix: expectedSuffix,
    });
  });

  it('does not remove an unrecognized final word', () => {
    expect(normalizeCompanyName('Acme Trading Group')).toEqual({
      full: 'acme trading group',
      base: 'acme trading group',
      legal_suffix: null,
    });
  });

  it('does not extract a suffix when no company base remains', () => {
    expect(normalizeCompanyName('PLC')).toEqual({
      full: 'plc',
      base: 'plc',
      legal_suffix: null,
    });
  });

  it.each([null, undefined, '', '   '])('maps %p to null', (value) => {
    expect(normalizeCompanyName(value)).toBeNull();
  });
});

describe('address normalization', () => {
  it('normalizes recognized components without moving or inventing values', () => {
    expect(
      normalizeAddress({
        line1: '  10 MAIN ST. ',
        line2: '',
        city: ' ADDIS   ABABA ',
        region: 'ĀDDIS',
        postal_code: ' ab-12 ',
        country: ' et ',
        ignored: 'source-only',
      }),
    ).toEqual({
      line1: '10 main st.',
      line2: null,
      city: 'addis ababa',
      region: 'āddis',
      postal_code: 'AB-12',
      country: 'ET',
    });
  });

  it('rejects an invalid country without discarding another component', () => {
    expect(normalizeAddress({ city: 'Nairobi', country: 'Kenya' })).toEqual({
      line1: null,
      line2: null,
      city: 'nairobi',
      region: null,
      postal_code: null,
      country: null,
    });
  });

  it.each([null, undefined, {}, { city: '   ' }, { city: 123 }])(
    'maps an address without usable components to null: %p',
    (value) => {
      expect(normalizeAddress(value as Record<string, unknown> | null | undefined)).toBeNull();
    },
  );
});

describe('record normalization', () => {
  it('normalizes a person record and creates a code-point-safe name prefix', () => {
    const longName = `${'😀'.repeat(64)}X`;
    const result = normalizeRecord('person', {
      name: longName,
      email: 'User+tag@EXAMPLE.COM',
      phone: '0911 223 344',
      company: ' ACME PLC ',
      company_domain: 'WWW.ACME.EXAMPLE.',
      address: { country: 'et' },
      attributes: { keep: 'raw only' },
    });

    expect(result.normalization_version).toBe('normalization-v1');
    expect(result.normalized_name_prefix).toBe('😀'.repeat(64));
    expect(Array.from(result.normalized_name_prefix ?? '')).toHaveLength(64);
    expect(result.normalized_email).toBe('User+tag@example.com');
    expect(result.normalized_phone).toBe('+251911223344');
    expect(result.company_domain).toBe('acme.example');
    expect(result.normalized_payload).toEqual({
      name: `${'😀'.repeat(64)}x`,
      email: 'User+tag@example.com',
      phone: '+251911223344',
      company: { full: 'acme plc', base: 'acme', legal_suffix: 'plc' },
      company_domain: 'acme.example',
      address: {
        line1: null,
        line2: null,
        city: null,
        region: null,
        postal_code: null,
        country: 'ET',
      },
    });
  });

  it('normalizes a company record and excludes raw-only registration data', () => {
    const result = normalizeRecord('company', {
      name: ' Resolve Incorporated ',
      domain: 'https://www.resolve.example/',
      registration_id: ' RAW-123 ',
    });

    expect(result).toEqual({
      normalization_version: 'normalization-v1',
      normalized_payload: {
        name: {
          full: 'resolve incorporated',
          base: 'resolve',
          legal_suffix: 'incorporated',
        },
        domain: 'resolve.example',
        email: null,
        phone: null,
        address: null,
      },
      normalized_email: null,
      normalized_phone: null,
      company_domain: 'resolve.example',
      normalized_name_prefix: 'resolve incorporated',
    });
  });

  it('uses company address country as national phone context', () => {
    expect(
      normalizeRecord('company', {
        name: 'Acme',
        phone: '0911 223 344',
        address: { country: 'ET' },
      }).normalized_phone,
    ).toBe('+251911223344');
  });

  it('treats non-string comparable fields as absent instead of stringifying them', () => {
    expect(
      normalizeRecord('person', {
        name: { unsafe: true },
        email: ['user@example.com'],
        phone: 251911223344,
        company_domain: false,
      }),
    ).toEqual({
      normalization_version: 'normalization-v1',
      normalized_payload: {
        name: null,
        email: null,
        phone: null,
        company: null,
        company_domain: null,
        address: null,
      },
      normalized_email: null,
      normalized_phone: null,
      company_domain: null,
      normalized_name_prefix: null,
    });
  });

  it('does not mutate raw source data', () => {
    const raw = {
      name: ' RAW NAME ',
      address: { city: ' RAW CITY ', country: 'et' },
      attributes: { source: 'crm' },
    };
    const before = structuredClone(raw);

    normalizeRecord('person', raw);

    expect(raw).toEqual(before);
  });
});
