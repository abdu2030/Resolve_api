import { presentString, type ComparableString } from './comparable-string.js';

const PREFIX_LIMIT = 4;
const WINKLER_SCALE = 0.1;
const WINKLER_THRESHOLD = 0.7;

export function jaroWinklerSimilarity(
  left: ComparableString,
  right: ComparableString,
): number | null {
  const presentLeft = presentString(left);
  const presentRight = presentString(right);
  if (presentLeft === null || presentRight === null) return null;
  if (presentLeft === presentRight) return 1;

  const leftPoints = Array.from(presentLeft);
  const rightPoints = Array.from(presentRight);
  const matchDistance = Math.max(
    0,
    Math.floor(Math.max(leftPoints.length, rightPoints.length) / 2) - 1,
  );
  const leftMatches = new Array<boolean>(leftPoints.length).fill(false);
  const rightMatches = new Array<boolean>(rightPoints.length).fill(false);

  let matches = 0;
  for (let leftIndex = 0; leftIndex < leftPoints.length; leftIndex += 1) {
    const start = Math.max(0, leftIndex - matchDistance);
    const end = Math.min(rightPoints.length, leftIndex + matchDistance + 1);

    for (let rightIndex = start; rightIndex < end; rightIndex += 1) {
      if (rightMatches[rightIndex] || leftPoints[leftIndex] !== rightPoints[rightIndex]) continue;
      leftMatches[leftIndex] = true;
      rightMatches[rightIndex] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let rightIndex = 0;
  for (let leftIndex = 0; leftIndex < leftPoints.length; leftIndex += 1) {
    if (!leftMatches[leftIndex]) continue;
    while (!rightMatches[rightIndex]) rightIndex += 1;
    if (leftPoints[leftIndex] !== rightPoints[rightIndex]) transpositions += 1;
    rightIndex += 1;
  }

  const jaro =
    (matches / leftPoints.length +
      matches / rightPoints.length +
      (matches - transpositions / 2) / matches) /
    3;
  const prefixLength = countSharedPrefix(leftPoints, rightPoints);
  const similarity =
    jaro >= WINKLER_THRESHOLD ? jaro + prefixLength * WINKLER_SCALE * (1 - jaro) : jaro;

  return Math.max(0, Math.min(1, similarity));
}

function countSharedPrefix(left: string[], right: string[]): number {
  const limit = Math.min(PREFIX_LIMIT, left.length, right.length);
  let prefixLength = 0;

  while (prefixLength < limit && left[prefixLength] === right[prefixLength]) {
    prefixLength += 1;
  }

  return prefixLength;
}
