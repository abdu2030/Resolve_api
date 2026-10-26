export class CanonicalizationDataIntegrityError extends Error {
  constructor() {
    super('Canonicalization data is incomplete or inconsistent');
    this.name = 'CanonicalizationDataIntegrityError';
  }
}
