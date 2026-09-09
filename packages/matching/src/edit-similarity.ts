import { presentString, type ComparableString } from './comparable-string.js';

export function editSimilarity(left: ComparableString, right: ComparableString): number | null {
  const presentLeft = presentString(left);
  const presentRight = presentString(right);
  if (presentLeft === null || presentRight === null) return null;
  if (presentLeft === presentRight) return 1;

  const leftPoints = Array.from(presentLeft);
  const rightPoints = Array.from(presentRight);
  const [shorter, longer] =
    leftPoints.length <= rightPoints.length ? [leftPoints, rightPoints] : [rightPoints, leftPoints];

  let previous = Array.from({ length: shorter.length + 1 }, (_, index) => index);

  for (let longIndex = 1; longIndex <= longer.length; longIndex += 1) {
    const current = [longIndex];

    for (let shortIndex = 1; shortIndex <= shorter.length; shortIndex += 1) {
      const substitutionCost = longer[longIndex - 1] === shorter[shortIndex - 1] ? 0 : 1;
      current[shortIndex] = Math.min(
        previous[shortIndex]! + 1,
        current[shortIndex - 1]! + 1,
        previous[shortIndex - 1]! + substitutionCost,
      );
    }

    previous = current;
  }

  const distance = previous[shorter.length]!;
  const denominator = Math.max(leftPoints.length, rightPoints.length);
  return Math.max(0, Math.min(1, 1 - distance / denominator));
}
