import { presentString, type ComparableString } from './comparable-string.js';

export function exactEquality(left: ComparableString, right: ComparableString): boolean | null {
  const presentLeft = presentString(left);
  const presentRight = presentString(right);
  if (presentLeft === null || presentRight === null) return null;
  return presentLeft === presentRight;
}
