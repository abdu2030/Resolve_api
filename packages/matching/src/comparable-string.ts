export type ComparableString = string | null | undefined;

export function presentString(value: ComparableString): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value;
}
