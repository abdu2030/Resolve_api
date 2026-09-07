import { createHash, randomBytes } from 'node:crypto';

export type ApiKeyEnvironment = 'live' | 'test';

export interface GeneratedApiKey {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export function generateApiKey(environment: ApiKeyEnvironment): GeneratedApiKey {
  const identifier = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const prefix = `rslv_${environment}_${identifier}`;
  const plaintext = `${prefix}.${secret}`;
  return { plaintext, prefix, hash: hashApiKey(plaintext) };
}

export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}
