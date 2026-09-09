import { addressCountryEquality, addressTokenSimilarity } from '../src/index.js';

const left = {
  line1: '10 bole road',
  line2: null,
  city: 'addis ababa',
  region: null,
  postal_code: '1000',
  country: 'ET',
};
const reordered = {
  line1: 'bole road 10',
  line2: null,
  city: 'addis ababa',
  region: null,
  postal_code: '1000',
  country: 'ET',
};

describe('address comparisons', () => {
  it('compares approved fields as order-insensitive address tokens', () => {
    expect(addressTokenSimilarity(left, reordered)).toBe(1);
  });

  it('compares countries exactly', () => {
    expect(addressCountryEquality(left, reordered)).toBe(true);
    expect(addressCountryEquality({ country: 'ET' }, { country: 'KE' })).toBe(false);
  });

  it('returns null when an address input is missing or has no approved fields', () => {
    expect(addressTokenSimilarity(null, reordered)).toBeNull();
    expect(addressTokenSimilarity({ unexpected: 'value' }, reordered)).toBeNull();
  });
});
