import { createHash } from 'node:crypto';

export function canonicalizeJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

export function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('unsupported non-finite JSON number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError('unsupported JSON value');
  if (ancestors.has(value)) throw new TypeError('cyclic JSON value');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, ancestors)).join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError('unsupported JSON object');
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, ancestors)}`);
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
