import { extractBearerToken, generateApiKey, hashApiKey } from './api-key.js';

describe('API key utilities', () => {
  it('generates an identifiable test key and stores only its SHA-256 hash', () => {
    const generated = generateApiKey('test');

    expect(generated.plaintext).toMatch(/^rslv_test_[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
    expect(generated.prefix).toMatch(/^rslv_test_[0-9a-f]{12}$/);
    expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.hash).toBe(hashApiKey(generated.plaintext));
    expect(generated.hash).not.toContain(generated.plaintext);
  });

  it('extracts only one well-formed Bearer credential', () => {
    expect(extractBearerToken('Bearer rslv_test_abcdef123456.secret')).toBe(
      'rslv_test_abcdef123456.secret',
    );
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer first second')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });
});
