import { normalizeText, type NormalizableValue } from './text.js';

export function normalizeName(value: NormalizableValue): string | null {
  return normalizeText(value)?.toLowerCase() ?? null;
}
