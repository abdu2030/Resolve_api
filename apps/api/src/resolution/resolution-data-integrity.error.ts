export class ResolutionDataIntegrityError extends Error {
  constructor() {
    super('Resolution data is incomplete or inconsistent');
    this.name = 'ResolutionDataIntegrityError';
  }
}
