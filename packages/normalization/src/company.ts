import { normalizeName } from './name.js';
import type { NormalizableValue } from './text.js';

export interface NormalizedCompanyName {
  full: string;
  base: string;
  legal_suffix: string | null;
}

const LEGAL_SUFFIXES = new Set([
  'plc',
  'ltd',
  'limited',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
]);

export function normalizeCompanyName(value: NormalizableValue): NormalizedCompanyName | null {
  const full = normalizeName(value);
  if (full === null) return null;

  const finalSpace = full.lastIndexOf(' ');
  const finalToken = full.slice(finalSpace + 1);
  const canonicalSuffix = finalToken.endsWith('.') ? finalToken.slice(0, -1) : finalToken;
  const proposedBase = full.slice(0, finalSpace + 1).replace(/[,\s]+$/gu, '');

  if (!LEGAL_SUFFIXES.has(canonicalSuffix) || proposedBase.length === 0) {
    return { full, base: full, legal_suffix: null };
  }

  return {
    full,
    base: proposedBase,
    legal_suffix: canonicalSuffix,
  };
}
