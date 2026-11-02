import { ApiException } from '../common/http/api-exception.js';

interface ReviewCursor {
  createdAt: Date;
  id: string;
}
export function encodeReviewCursor(row: ReviewCursor, status: string): string {
  return Buffer.from(
    JSON.stringify({
      kind: 'review-v1',
      status,
      created_at: row.createdAt.toISOString(),
      id: row.id,
    }),
  ).toString('base64url');
}
export function decodeReviewCursor(value: string, status: string): ReviewCursor {
  try {
    if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const row: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error();
    const item = row as Record<string, unknown>;
    if (
      Object.keys(item).length !== 4 ||
      item.kind !== 'review-v1' ||
      item.status !== status ||
      typeof item.created_at !== 'string' ||
      typeof item.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.id)
    )
      throw new Error();
    const createdAt = new Date(item.created_at);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== item.created_at)
      throw new Error();
    return { createdAt, id: item.id.toLowerCase() };
  } catch {
    throw new ApiException(400, 'INVALID_CURSOR', 'Review cursor is invalid');
  }
}
