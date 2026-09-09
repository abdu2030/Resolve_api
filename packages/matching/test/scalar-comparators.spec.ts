import {
  domainEquality,
  editSimilarity,
  exactEquality,
  jaroWinklerSimilarity,
  presentString,
  tokenSimilarity,
} from '../src/index.js';

describe('presentString', () => {
  it.each([null, undefined, '', '   '])('returns null for %p', (missing) => {
    expect(presentString(missing)).toBeNull();
  });

  it('preserves present source text without normalization', () => {
    expect(presentString('  User@example.com  ')).toBe('  User@example.com  ');
  });
});

describe('exactEquality', () => {
  it.each([null, undefined, '', '   '])('returns null when one value is %p', (missing) => {
    expect(exactEquality(missing, 'value')).toBeNull();
    expect(exactEquality('value', missing)).toBeNull();
  });

  it('distinguishes normalized equality from inequality', () => {
    expect(exactEquality('User@example.com', 'User@example.com')).toBe(true);
    expect(exactEquality('User@example.com', 'user@example.com')).toBe(false);
  });
});

describe('editSimilarity', () => {
  it.each([
    ['kitten', 'sitting', 4 / 7],
    ['café', 'cafe', 0.75],
    ['李', '李', 1],
    ['a', 'b', 0],
    ['😀', '😃', 0],
  ] as const)('compares %s and %s', (left, right, expected) => {
    expect(editSimilarity(left, right)).toBeCloseTo(expected, 10);
    expect(editSimilarity(right, left)).toBeCloseTo(expected, 10);
  });

  it('returns null for missing input', () => {
    expect(editSimilarity('', 'value')).toBeNull();
    expect(editSimilarity(null, 'value')).toBeNull();
  });
});

describe('jaroWinklerSimilarity', () => {
  it.each([
    ['martha', 'marhta'],
    ['dixon', 'dicksonx'],
    ['aab', 'aba'],
    ['😀ab', '😀ba'],
    ['a', 'xyz'],
  ] as const)('is symmetric for %s and %s', (left, right) => {
    expect(jaroWinklerSimilarity(left, right)).toBeCloseTo(jaroWinklerSimilarity(right, left)!, 10);
  });

  it.each([
    ['a', 'b', 0],
    ['李明', '李明', 1],
    ['martha', 'marhta', 173 / 180],
  ] as const)('stays within inclusive bounds for %s and %s', (left, right, expected) => {
    const similarity = jaroWinklerSimilarity(left, right);
    expect(similarity).toBeCloseTo(expected, 10);
    expect(similarity).toBeGreaterThanOrEqual(0);
    expect(similarity).toBeLessThanOrEqual(1);
  });

  it.each([
    ['abcdefx', 'abcdefy', 33 / 35],
    ['😀😃😄😁abx', '😀😃😄😁aby', 33 / 35],
    ['😀abx', '😀aby', 53 / 60],
  ] as const)('caps the prefix at four code points for %s and %s', (left, right, expected) => {
    expect(jaroWinklerSimilarity(left, right)).toBeCloseTo(expected, 10);
    expect(jaroWinklerSimilarity(right, left)).toBeCloseTo(expected, 10);
  });

  it.each([
    // Jaro = 5/9: a shared prefix must not boost evidence below 0.7.
    ['below', 'abxxxx', 'abyyyy', 5 / 9],
    // Two matches, lengths 2 and 20, no transpositions: Jaro = 7/10.
    ['at', 'ab', 'abxxxxxxxxxxxxxxxxxx', 19 / 25],
    // Jaro = 5/6 and a three-code-point prefix.
    ['above', 'abcx', 'abcy', 53 / 60],
  ] as const)('applies the prefix adjustment %s the 0.7 threshold', (_, left, right, expected) => {
    expect(jaroWinklerSimilarity(left, right)).toBeCloseTo(expected, 10);
    expect(jaroWinklerSimilarity(right, left)).toBeCloseTo(expected, 10);
  });

  it('compares transposed, reordered, and Unicode text', () => {
    expect(jaroWinklerSimilarity('martha', 'marhta')).toBeCloseTo(0.961_111, 5);
    expect(jaroWinklerSimilarity('dixon', 'dicksonx')).toBeCloseTo(0.813_333, 5);
    expect(jaroWinklerSimilarity('李明', '李明')).toBe(1);
  });

  it('returns null for missing input', () => {
    expect(jaroWinklerSimilarity(null, 'name')).toBeNull();
  });
});

describe('tokenSimilarity', () => {
  it.each([
    ['acme,', 'acme', 0],
    ['acme, trading', 'acme trading', 1 / 3],
  ] as const)('preserves punctuation in %s and %s', (left, right, expected) => {
    expect(tokenSimilarity(left, right)).toBeCloseTo(expected, 10);
  });

  it('compares unique whitespace-delimited Unicode tokens regardless of order', () => {
    expect(tokenSimilarity('acme trading', 'trading acme')).toBe(1);
    expect(tokenSimilarity('acme acme trading', 'acme trading')).toBe(1);
    expect(tokenSimilarity('blue nile', 'rift valley')).toBe(0);
    expect(tokenSimilarity('café 李', '李 café')).toBe(1);
  });

  it('returns null for missing input', () => {
    expect(tokenSimilarity('   ', 'acme')).toBeNull();
  });
});

describe('domainEquality', () => {
  it('compares normalized domain values exactly', () => {
    expect(domainEquality('example.com', 'example.com')).toBe(true);
    expect(domainEquality('a.example', 'b.example')).toBe(false);
  });

  it('returns null for missing input', () => {
    expect(domainEquality(null, 'example.com')).toBeNull();
  });
});
