import { normalizeName } from './name.js';
import { normalizeText } from './text.js';

export interface NormalizedAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
}

export function normalizeAddress(
  value: Record<string, unknown> | null | undefined,
): NormalizedAddress | null {
  if (value === null || value === undefined || Array.isArray(value)) return null;

  const line1 = normalizeName(stringValue(value.line1));
  const line2 = normalizeName(stringValue(value.line2));
  const city = normalizeName(stringValue(value.city));
  const region = normalizeName(stringValue(value.region));
  const postalCode = normalizeText(stringValue(value.postal_code))?.toUpperCase() ?? null;
  const preparedCountry = normalizeText(stringValue(value.country))?.toUpperCase() ?? null;
  const country =
    preparedCountry !== null && /^[A-Z]{2}$/u.test(preparedCountry) ? preparedCountry : null;

  if (
    line1 === null &&
    line2 === null &&
    city === null &&
    region === null &&
    postalCode === null &&
    country === null
  ) {
    return null;
  }

  return {
    line1,
    line2,
    city,
    region,
    postal_code: postalCode,
    country,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
