import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ApiException } from '../common/http/api-exception.js';
import {
  decodeHistoryCursor,
  decodeRecordCursor,
  encodeHistoryCursor,
  encodeRecordCursor,
} from './entity-cursor.js';
import { EntityPageQueryDto } from './entity-pagination.dto.js';

const recordId = '11111111-1111-4111-8111-111111111111';
const createdAt = new Date('2026-09-09T10:00:00.000Z');

describe('entity cursors', () => {
  it('round-trips the record ordering keys', () => {
    expect(decodeRecordCursor(encodeRecordCursor({ createdAt, id: recordId }))).toEqual({
      createdAt,
      id: recordId,
    });
  });

  it('round-trips a positive history version', () => {
    expect(decodeHistoryCursor(encodeHistoryCursor(17))).toBe(17);
  });

  it.each([
    ['invalid base64url', '*not-base64url*'],
    ['invalid JSON', Buffer.from('{', 'utf8').toString('base64url')],
    [
      'wrong record kind',
      opaque({
        kind: 'history',
        version: 1,
        createdAt: createdAt.toISOString(),
        id: recordId,
      }),
    ],
    [
      'wrong codec version',
      opaque({ kind: 'record', version: 2, createdAt: createdAt.toISOString(), id: recordId }),
    ],
    [
      'invalid timestamp',
      opaque({ kind: 'record', version: 1, createdAt: 'not-a-date', id: recordId }),
    ],
    [
      'invalid UUID',
      opaque({ kind: 'record', version: 1, createdAt: createdAt.toISOString(), id: 'record-1' }),
    ],
    [
      'extra property',
      opaque({
        kind: 'record',
        version: 1,
        createdAt: createdAt.toISOString(),
        id: recordId,
        tenantId: recordId,
      }),
    ],
  ])('rejects a record cursor with %s', (_case, value) => {
    expect.assertions(3);
    expectInvalidCursor(() => decodeRecordCursor(value));
  });

  it.each([
    ['wrong history kind', opaque({ kind: 'record', version: 1, value: 3 })],
    ['wrong codec version', opaque({ kind: 'history', version: 2, value: 3 })],
    ['zero history value', opaque({ kind: 'history', version: 1, value: 0 })],
    ['negative history value', opaque({ kind: 'history', version: 1, value: -1 })],
    ['fractional history value', opaque({ kind: 'history', version: 1, value: 1.5 })],
    ['extra property', opaque({ kind: 'history', version: 1, value: 3, entityId: recordId })],
  ])('rejects a history cursor with %s', (_case, value) => {
    expect.assertions(3);
    expectInvalidCursor(() => decodeHistoryCursor(value));
  });
});

describe('EntityPageQueryDto', () => {
  it('transforms an integer limit and accepts an opaque cursor', async () => {
    const query = plainToInstance(EntityPageQueryDto, { limit: '25', cursor: 'opaque' });

    await expect(validateQuery(query)).resolves.toEqual([]);
    expect(query).toEqual({ limit: 25, cursor: 'opaque' });
  });

  it.each([0, 101, 1.5, 'not-a-number'])('rejects invalid limit %p', async (limit) => {
    const query = plainToInstance(EntityPageQueryDto, { limit });

    await expect(validateQuery(query)).resolves.not.toHaveLength(0);
  });

  it('rejects a non-string cursor', async () => {
    const query = plainToInstance(EntityPageQueryDto, { cursor: 123 });

    await expect(validateQuery(query)).resolves.not.toHaveLength(0);
  });
});

function opaque(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function expectInvalidCursor(operation: () => unknown): void {
  try {
    operation();
    throw new Error('Expected cursor decoding to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getStatus()).toBe(400);
    expect((error as ApiException).getResponse()).toEqual({
      error: { code: 'INVALID_CURSOR', message: 'Cursor is invalid' },
    });
  }
}

function validateQuery(query: EntityPageQueryDto): ReturnType<typeof validate> {
  return validate(query, { forbidNonWhitelisted: true, whitelist: true });
}
