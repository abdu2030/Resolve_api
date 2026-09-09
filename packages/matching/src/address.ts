import { presentString, type ComparableString } from './comparable-string.js';
import { exactEquality } from './exact.js';
import { tokenSimilarity } from './token-similarity.js';

const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'region', 'postal_code', 'country'] as const;

type AddressField = (typeof ADDRESS_FIELDS)[number];
type AddressObject = Record<AddressField, unknown>;

export function addressTokenSimilarity(left: unknown, right: unknown): number | null {
  return tokenSimilarity(joinAddressFields(left), joinAddressFields(right));
}

export function addressCountryEquality(left: unknown, right: unknown): boolean | null {
  return exactEquality(readAddressField(left, 'country'), readAddressField(right, 'country'));
}

function joinAddressFields(address: unknown): string | null {
  const values = ADDRESS_FIELDS.map((field) => readAddressField(address, field)).filter(
    (value): value is string => value !== null,
  );

  return values.length > 0 ? values.join(' ') : null;
}

function readAddressField(address: unknown, field: AddressField): ComparableString {
  if (typeof address !== 'object' || address === null || Array.isArray(address)) return null;

  const value = (address as AddressObject)[field];
  return typeof value === 'string' ? presentString(value) : null;
}
