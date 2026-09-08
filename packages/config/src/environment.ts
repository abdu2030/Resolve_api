export type NodeEnvironment = 'development' | 'production' | 'test';

export interface EnvironmentConfig {
  apiPort: number;
  blockingMaxCandidates: number;
  databaseUrl: string;
  nodeEnv: NodeEnvironment;
  redisHost: string;
  redisPort: number;
  requestBodyLimit: string;
}

const SUPPORTED_ENVIRONMENTS = new Set<NodeEnvironment>(['development', 'production', 'test']);
const BODY_LIMIT_PATTERN = /^\d+(?:b|kb|mb)$/i;
const DEFAULT_BLOCKING_MAX_CANDIDATES = 100;
const MAX_BLOCKING_CANDIDATES = 1000;

function invalid(key: string): never {
  throw new Error(`Invalid environment variable: ${key}`);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalid(key);
  }
  return value.trim();
}

function port(input: Record<string, unknown>, key: string): number {
  const value = requiredString(input, key);
  if (!/^\d+$/.test(value)) {
    return invalid(key);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return invalid(key);
  }
  return parsed;
}

function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  defaultValue: number,
  maximum: number,
): number {
  const value = input[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return invalid(key);

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    return invalid(key);
  }
  return parsed;
}

export function validateEnvironment(input: Record<string, unknown>): EnvironmentConfig {
  const nodeEnv = requiredString(input, 'NODE_ENV');
  if (!SUPPORTED_ENVIRONMENTS.has(nodeEnv as NodeEnvironment)) {
    return invalid('NODE_ENV');
  }

  const requestBodyLimit = requiredString(input, 'REQUEST_BODY_LIMIT');
  if (!BODY_LIMIT_PATTERN.test(requestBodyLimit)) {
    return invalid('REQUEST_BODY_LIMIT');
  }

  return {
    apiPort: port(input, 'API_PORT'),
    blockingMaxCandidates: optionalInteger(
      input,
      'BLOCKING_MAX_CANDIDATES',
      DEFAULT_BLOCKING_MAX_CANDIDATES,
      MAX_BLOCKING_CANDIDATES,
    ),
    databaseUrl: requiredString(input, 'DATABASE_URL'),
    nodeEnv: nodeEnv as NodeEnvironment,
    redisHost: requiredString(input, 'REDIS_HOST'),
    redisPort: port(input, 'REDIS_PORT'),
    requestBodyLimit,
  };
}
