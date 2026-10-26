import { ApiException } from '../common/http/api-exception.js';

const CURSOR_CODEC_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface RecordCursor {
  createdAt: Date;
  id: string;
}

export function encodeRecordCursor(cursor: RecordCursor): string {
  if (!validDate(cursor.createdAt) || !UUID_V4.test(cursor.id)) throw invalidCursor();
  return encode({
    kind: 'record',
    version: CURSOR_CODEC_VERSION,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
}

export function decodeRecordCursor(value: string): RecordCursor {
  const decoded = decode(value);
  if (
    !hasExactKeys(decoded, ['kind', 'version', 'createdAt', 'id']) ||
    decoded.kind !== 'record' ||
    decoded.version !== CURSOR_CODEC_VERSION ||
    typeof decoded.createdAt !== 'string' ||
    typeof decoded.id !== 'string' ||
    !UUID_V4.test(decoded.id)
  ) {
    throw invalidCursor();
  }
  const createdAt = new Date(decoded.createdAt);
  if (!validDate(createdAt) || createdAt.toISOString() !== decoded.createdAt) {
    throw invalidCursor();
  }
  return { createdAt, id: decoded.id };
}

export function encodeHistoryCursor(version: number): string {
  if (!Number.isSafeInteger(version) || version <= 0) throw invalidCursor();
  return encode({ kind: 'history', version: CURSOR_CODEC_VERSION, value: version });
}

export function decodeHistoryCursor(value: string): number {
  const decoded = decode(value);
  if (
    !hasExactKeys(decoded, ['kind', 'version', 'value']) ||
    decoded.kind !== 'history' ||
    decoded.version !== CURSOR_CODEC_VERSION ||
    typeof decoded.value !== 'number' ||
    !Number.isSafeInteger(decoded.value) ||
    decoded.value <= 0
  ) {
    throw invalidCursor();
  }
  return decoded.value;
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value: string): Record<string, unknown> {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw invalidCursor();
  }
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw invalidCursor();
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!plainObject(parsed)) throw invalidCursor();
    return parsed;
  } catch (error) {
    if (error instanceof ApiException) throw error;
    throw invalidCursor();
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

function invalidCursor(): ApiException {
  return new ApiException(400, 'INVALID_CURSOR', 'Cursor is invalid');
}
