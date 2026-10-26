import { canonicalizeJson, hashCanonicalJson } from './canonical-json.js';

describe('canonical JSON', () => {
  it('produces the same representation and hash for different object key order', () => {
    const first = { phone: '0911', profile: { city: 'Addis', name: 'Abdul' } };
    const second = { profile: { name: 'Abdul', city: 'Addis' }, phone: '0911' };

    expect(canonicalizeJson(first)).toBe(
      '{"phone":"0911","profile":{"city":"Addis","name":"Abdul"}}',
    );
    expect(hashCanonicalJson(first)).toBe(hashCanonicalJson(second));
  });

  it('orders object keys by stable Unicode code units instead of host locale', () => {
    expect(canonicalizeJson({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
  });
  it('preserves array order when hashing', () => {
    expect(hashCanonicalJson({ values: ['a', 'b'] })).not.toBe(
      hashCanonicalJson({ values: ['b', 'a'] }),
    );
  });

  it('rejects cyclic and unsupported values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalizeJson(cyclic)).toThrow('cyclic');
    expect(() => canonicalizeJson({ missing: undefined })).toThrow('unsupported');
  });
});
