export type NodeEnvironment = 'development' | 'production' | 'test';

export interface EnvironmentConfig {
  apiPort: number;
  batchQueuePrefix: string;
  blockingMaxCandidates: number;
  databaseUrl: string;
  metricsToken?: string;
  nodeEnv: NodeEnvironment;
  rateLimitBatchKeyMax: number;
  rateLimitBatchTenantMax: number;
  rateLimitKeyMax: number;
  rateLimitTenantMax: number;
  rateLimitWindowSeconds: number;
  redisHost: string;
  redisPort: number;
  requestBodyLimit: string;
  webhookEncryptionKey?: string;
  webhookMaxAttempts: number;
  webhookRetryBaseMs: number;
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

function optionalHexSecret(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return invalid(key);
  return value;
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

  const batchQueuePrefix = input.BATCH_QUEUE_PREFIX ?? 'resolve';
  if (typeof batchQueuePrefix !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(batchQueuePrefix)) {
    return invalid('BATCH_QUEUE_PREFIX');
  }

  const metricsToken = optionalHexSecret(input, 'METRICS_TOKEN');
  const webhookEncryptionKey = optionalHexSecret(input, 'WEBHOOK_ENCRYPTION_KEY');

  return {
    apiPort: port(input, 'API_PORT'),
    batchQueuePrefix,
    blockingMaxCandidates: optionalInteger(
      input,
      'BLOCKING_MAX_CANDIDATES',
      DEFAULT_BLOCKING_MAX_CANDIDATES,
      MAX_BLOCKING_CANDIDATES,
    ),
    databaseUrl: requiredString(input, 'DATABASE_URL'),
    ...(metricsToken ? { metricsToken } : {}),
    nodeEnv: nodeEnv as NodeEnvironment,
    rateLimitBatchKeyMax: optionalInteger(input, 'RATE_LIMIT_BATCH_KEY_MAX', 20, 100_000),
    rateLimitBatchTenantMax: optionalInteger(input, 'RATE_LIMIT_BATCH_TENANT_MAX', 100, 100_000),
    rateLimitKeyMax: optionalInteger(input, 'RATE_LIMIT_KEY_MAX', 600, 100_000),
    rateLimitTenantMax: optionalInteger(input, 'RATE_LIMIT_TENANT_MAX', 3000, 100_000),
    rateLimitWindowSeconds: optionalInteger(input, 'RATE_LIMIT_WINDOW_SECONDS', 60, 3600),
    redisHost: requiredString(input, 'REDIS_HOST'),
    redisPort: port(input, 'REDIS_PORT'),
    requestBodyLimit,
    ...(webhookEncryptionKey ? { webhookEncryptionKey } : {}),
    webhookMaxAttempts: optionalInteger(input, 'WEBHOOK_MAX_ATTEMPTS', 5, 10),
    webhookRetryBaseMs: optionalInteger(input, 'WEBHOOK_RETRY_BASE_MS', 1000, 60_000),
  };
}
