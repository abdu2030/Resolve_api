import { presentString, type ComparableString } from './comparable-string.js';

export function tokenSimilarity(left: ComparableString, right: ComparableString): number | null {
  const presentLeft = presentString(left);
  const presentRight = presentString(right);
  if (presentLeft === null || presentRight === null) return null;

  const leftTokens = new Set(
    Array.from(presentLeft.split(/\s+/u)).filter((token) => token.length > 0),
  );
  const rightTokens = new Set(
    Array.from(presentRight.split(/\s+/u)).filter((token) => token.length > 0),
  );
  const union = new Set([...leftTokens, ...rightTokens]);
  let intersection = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }

  return intersection / union.size;
}
