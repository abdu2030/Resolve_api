export type NormalizableValue = string | null | undefined;

export function normalizeText(value: NormalizableValue): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return normalized.length === 0 ? null : normalized;
}
