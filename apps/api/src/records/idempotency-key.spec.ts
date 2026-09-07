import { validateIdempotencyKey } from './idempotency-key.js';

describe('Idempotency-Key validation', () => {
  it('accepts visible ASCII values up to 255 characters', () => {
    expect(validateIdempotencyKey(undefined)).toBeUndefined();
    expect(validateIdempotencyKey('record-create:42')).toBe('record-create:42');
    expect(validateIdempotencyKey('x'.repeat(255))).toHaveLength(255);
  });

  it.each(['', 'contains space', 'contains\ttab', 'x'.repeat(256), 'unicode-ሀ'])(
    'rejects invalid value %p',
    (value) => expect(() => validateIdempotencyKey(value)).toThrow('Idempotency-Key'),
  );
});
