import { randomUUID } from 'node:crypto';
import { decodeReviewCursor, encodeReviewCursor } from './review-cursor.js';

describe('review pagination cursor', () => {
  const row = { id: randomUUID(), createdAt: new Date('2026-01-01T00:00:00.000Z') };
  it('roundtrips a stable tie-breaker and binds it to the status filter', () => {
    const cursor = encodeReviewCursor(row, 'OPEN');
    expect(decodeReviewCursor(cursor, 'OPEN')).toEqual(row);
    expect(() => decodeReviewCursor(cursor, 'RESOLVED')).toThrow('Review cursor is invalid');
  });
  it.each([
    '',
    '!',
    'x'.repeat(2049),
    Buffer.from('{}').toString('base64url'),
    Buffer.from('null').toString('base64url'),
  ])('rejects malformed cursor %s', (cursor) => {
    expect(() => decodeReviewCursor(cursor, 'OPEN')).toThrow('Review cursor is invalid');
  });
});
