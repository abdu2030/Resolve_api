export class EntityDataIntegrityError extends Error {
  constructor() {
    super('Stored entity data is inconsistent');
    this.name = 'EntityDataIntegrityError';
  }
}
