import type { BlockingCandidate, BlockingPassRows, BlockingResult } from './blocking.types.js';

type CollectedCandidates = Pick<BlockingResult, 'candidates' | 'truncated'>;

export function collectCandidates(
  passes: BlockingPassRows[],
  maximum: number,
): CollectedCandidates {
  const candidatesByEntity = new Map<string, BlockingCandidate>();
  let truncated = false;

  for (const pass of passes) {
    if (pass.rows.length > maximum) truncated = true;

    for (const row of pass.rows.slice(0, maximum)) {
      const existing = candidatesByEntity.get(row.entityId);
      if (!existing) {
        candidatesByEntity.set(row.entityId, {
          entityId: row.entityId,
          entityType: row.entityType,
          matchedOn: [pass.signal],
          supportingRecordIds: [row.supportingRecordId],
        });
        continue;
      }

      if (!existing.matchedOn.includes(pass.signal)) {
        existing.matchedOn.push(pass.signal);
      }
      if (!existing.supportingRecordIds.includes(row.supportingRecordId)) {
        existing.supportingRecordIds.push(row.supportingRecordId);
      }
    }
  }

  const candidates = [...candidatesByEntity.values()];
  if (candidates.length > maximum) truncated = true;

  return {
    candidates: candidates.slice(0, maximum),
    truncated,
  };
}
