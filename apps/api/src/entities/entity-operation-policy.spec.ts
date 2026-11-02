import { ApiException } from '../common/http/api-exception.js';
import {
  assertActiveEntity,
  assertOperationBound,
  assertVersion,
  mergeRecordIds,
  splitRecordIds,
  reversalRecordIds,
} from './entity-operation-policy.js';

const a = 'aaaaaaaa-0000-4000-8000-000000000001';
const b = 'bbbbbbbb-0000-4000-8000-000000000002';
const entity = { id: a, status: 'ACTIVE', entityType: 'PERSON', canonicalVersion: 1 };
function code(action: () => unknown, expected: string): void {
  try {
    action();
    throw new Error('Expected denial');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({ error: { code: expected } });
  }
}
describe('entity operation policy', () => {
  it('requires active entities and exact incrementable versions', () => {
    expect(() => assertActiveEntity(entity)).not.toThrow();
    expect(() => assertVersion(entity, 1)).not.toThrow();
    code(() => assertActiveEntity({ ...entity, status: 'MERGED' }), 'ENTITY_NOT_ACTIVE');
    code(() => assertVersion(entity, 0), 'ENTITY_VERSION_CONFLICT');
    code(
      () => assertVersion({ ...entity, canonicalVersion: 2147483647 }, 2147483647),
      'ENTITY_VERSION_CONFLICT',
    );
  });
  it('merges only distinct same-type nonempty entities within the bound', () => {
    expect(mergeRecordIds(entity, { ...entity, id: b }, [a], [b])).toEqual([a]);
    code(
      () => mergeRecordIds(entity, { ...entity, id: a.toUpperCase() }, [a], [b]),
      'INVALID_ENTITY_MERGE',
    );
    code(
      () => mergeRecordIds(entity, { ...entity, id: b, entityType: 'COMPANY' }, [a], [b]),
      'ENTITY_TYPE_CONFLICT',
    );
    code(() => mergeRecordIds(entity, { ...entity, id: b }, [], [b]), 'INVALID_ENTITY_MERGE');
    code(() => assertOperationBound(1001), 'ENTITY_OPERATION_LIMIT');
    expect(() => assertOperationBound(1000)).not.toThrow();
  });
  it('normalizes sets while requiring a proper owned subset', () => {
    expect(splitRecordIds([a, b], [a.toUpperCase()])).toEqual([a]);
    code(() => splitRecordIds([a, b], []), 'INVALID_ENTITY_SPLIT');
    code(() => splitRecordIds([a, b], [a, b]), 'INVALID_ENTITY_SPLIT');
    code(() => splitRecordIds([a, b], [a, a.toUpperCase()]), 'INVALID_ENTITY_SPLIT');
    code(() => splitRecordIds([a], [b]), 'SOURCE_RECORD_NOT_FOUND');
  });
  it('reverses only directly merged nonempty proper event memberships', () => {
    const restored = { ...entity, status: 'MERGED', mergedIntoEntityId: b };
    expect(reversalRecordIds(restored, b, [a, b], [a], false, false)).toEqual([a]);
    code(() => reversalRecordIds(restored, b, [a, b], [a], true, false), 'MERGE_ALREADY_REVERSED');
    code(() => reversalRecordIds(restored, b, [b], [a], false, false), 'MERGE_REVERSAL_CONFLICT');
    code(() => reversalRecordIds(restored, b, [a], [a], false, false), 'MERGE_REVERSAL_CONFLICT');
    code(() => reversalRecordIds(restored, b, [a, b], [a], false, true), 'MERGE_REVERSAL_CONFLICT');
    code(
      () => reversalRecordIds({ ...restored, status: 'ACTIVE' }, b, [a, b], [a], false, false),
      'MERGE_REVERSAL_CONFLICT',
    );
    code(
      () => reversalRecordIds({ ...restored, mergedIntoEntityId: a }, b, [a, b], [a], false, false),
      'MERGE_REVERSAL_CONFLICT',
    );
  });
});
