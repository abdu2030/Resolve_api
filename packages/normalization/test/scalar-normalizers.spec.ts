import {
  normalizeDomain,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeText,
} from '../src/index.js';

describe('text normalization', () => {
  it.each([null, undefined, '', '   ', '\u00a0'])('maps %p to null', (value) => {
    expect(normalizeText(value)).toBeNull();
  });

  it('uses NFKC and collapses Unicode whitespace', () => {
    expect(normalizeText('  ＡＢＤＵＬ\tJosé\u00a0 李  ')).toBe('ABDUL José 李');
  });
});

describe('name normalization', () => {
  it('lowercases while preserving punctuation, accents, and non-Latin scripts', () => {
    expect(normalizeName('  Ｏ’ＮＥＩＬ\tJosé  李  ')).toBe('o’neil josé 李');
  });
});

describe('email normalization', () => {
  it('preserves local-part case, dots, and plus-tags while normalizing the domain', () => {
    expect(normalizeEmail(' User.Name+sales@EXAMPLE.COM ')).toBe('User.Name+sales@example.com');
  });

  it.each([
    'missing-at.example.com',
    '.user@example.com',
    'user.@example.com',
    'a..b@example.com',
    'a@b@example.com',
    'user()@example.com',
    'user,@example.com',
    'üser@example.com',
    'user@localhost',
  ])('rejects invalid email %s', (value) => {
    expect(normalizeEmail(value)).toBeNull();
  });

  it.each([null, undefined, '', '   '])('maps %p to null', (value) => {
    expect(normalizeEmail(value)).toBeNull();
  });
});

describe('domain normalization', () => {
  it.each([
    ['HTTPS://WWW.Example.COM/', 'example.com'],
    ['www.example.com.', 'example.com'],
    ['münich.example', 'xn--mnich-kva.example'],
  ])('normalizes %s to %s', (value, expected) => {
    expect(normalizeDomain(value)).toBe(expected);
  });

  it.each([
    'ftp://example.com',
    'https://example.com/path',
    'https://user@example.com',
    'https://example.com:443',
    'https://example.com?query=1',
    'https://example.com#fragment',
    'example.com:443',
    '127.0.0.1',
    'localhost',
    '*.example.com',
    'example..com',
  ])('rejects non-company-domain value %s', (value) => {
    expect(normalizeDomain(value)).toBeNull();
  });

  it.each([null, undefined, '', '   '])('maps %p to null', (value) => {
    expect(normalizeDomain(value)).toBeNull();
  });
});

describe('phone normalization', () => {
  it('normalizes Ethiopian national format with country context', () => {
    expect(normalizePhone('0911 223 344', 'et')).toBe('+251911223344');
  });

  it('normalizes an international number without country context', () => {
    expect(normalizePhone('+251 911 223 344')).toBe('+251911223344');
  });

  it.each([
    ['0911 223 344', undefined],
    ['123', 'ET'],
    ['', 'ET'],
    ['0911 223 344', 'ZZ'],
  ] as const)(
    'returns null for ambiguous or invalid phone %s with country %s',
    (value, country) => {
      expect(normalizePhone(value, country)).toBeNull();
    },
  );
});
