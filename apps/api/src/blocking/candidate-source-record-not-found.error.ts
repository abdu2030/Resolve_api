export class CandidateSourceRecordNotFoundError extends Error {
  constructor() {
    super('Source record is not available for candidate generation');
    this.name = 'CandidateSourceRecordNotFoundError';
  }
}
