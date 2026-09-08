import { validateEnvironment } from '../src/index.js';

const validEnvironment = {
  API_PORT: '3000',
  DATABASE_URL: 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public',
  NODE_ENV: 'development',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  REQUEST_BODY_LIMIT: '1mb',
};

function captureErrorMessage(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('Expected operation to throw');
}

describe('validateEnvironment', () => {
  it('returns a typed configuration for complete valid input', () => {
    expect(validateEnvironment(validEnvironment)).toEqual({
      apiPort: 3000,
      blockingMaxCandidates: 100,
      databaseUrl: validEnvironment.DATABASE_URL,
      nodeEnv: 'development',
      redisHost: 'localhost',
      redisPort: 6379,
      requestBodyLimit: '1mb',
    });
  });

  it.each([
    ['minimum', '1', 1],
    ['maximum', '1000', 1000],
  ])('accepts the %s candidate limit', (_, value, expected) => {
    expect(
      validateEnvironment({ ...validEnvironment, BLOCKING_MAX_CANDIDATES: value })
        .blockingMaxCandidates,
    ).toBe(expected);
  });

  it.each([
    ['blank', ''],
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['too large', '1001'],
    ['non-numeric', 'many'],
  ])('rejects %s BLOCKING_MAX_CANDIDATES', (_, value) => {
    const message = captureErrorMessage(() =>
      validateEnvironment({ ...validEnvironment, BLOCKING_MAX_CANDIDATES: value }),
    );

    expect(message).toContain('BLOCKING_MAX_CANDIDATES');
    expect(message).not.toContain(value || '__blank_candidate_limit__');
  });

  it.each([
    ['DATABASE_URL', { ...validEnvironment, DATABASE_URL: '' }],
    ['API_PORT', { ...validEnvironment, API_PORT: 'zero' }],
    ['API_PORT', { ...validEnvironment, API_PORT: '65536' }],
    ['REDIS_PORT', { ...validEnvironment, REDIS_PORT: '0' }],
    ['NODE_ENV', { ...validEnvironment, NODE_ENV: 'preview' }],
  ])('rejects invalid %s without echoing values', (key, environment) => {
    const message = captureErrorMessage(() => validateEnvironment(environment));
    const invalidValue = String(environment[key as keyof typeof environment]);
    const valueThatMustNotLeak = invalidValue || '__no_invalid_value__';

    expect(message).toContain(key);
    expect(message).not.toContain(valueThatMustNotLeak);
  });
});
