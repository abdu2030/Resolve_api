import { type ComparableString } from './comparable-string.js';
import { exactEquality } from './exact.js';

export function domainEquality(left: ComparableString, right: ComparableString): boolean | null {
  return exactEquality(left, right);
}
