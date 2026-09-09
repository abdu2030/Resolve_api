import { type EntityType } from '@resolve/contracts';

export class EntityTypeMismatchError extends Error {
  constructor(leftEntityType: EntityType, rightEntityType: EntityType) {
    super(
      `Cannot extract features for mixed entity types: ${leftEntityType} and ${rightEntityType}.`,
    );
    this.name = 'EntityTypeMismatchError';
  }
}
