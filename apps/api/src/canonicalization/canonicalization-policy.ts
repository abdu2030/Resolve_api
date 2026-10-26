import { EntityType } from '@resolve/contracts';

import { CANONICALIZATION_VERSION } from './canonicalization.constants.js';
import { CanonicalizationDataIntegrityError } from './canonicalization-data-integrity.error.js';
import type {
  CanonicalFieldSelection,
  CanonicalProjection,
  CanonicalSelectionRule,
  CanonicalizationRecord,
} from './canonicalization.types.js';

type FieldPath =
  | 'name'
  | 'email'
  | 'phone'
  | 'company'
  | 'company_domain'
  | 'domain'
  | 'registration_id'
  | 'address.line1'
  | 'address.city'
  | 'address.region'
  | 'address.postal_code'
  | 'address.country';

interface FieldDescriptor {
  path: FieldPath;
  kind: 'display' | 'identifier' | 'registration';
  normalizedKey?: string;
  companyName?: boolean;
}

interface Candidate {
  fieldPath: FieldPath;
  canonicalValue: string;
  rawValue: string;
  sourceRecordId: string;
  sourceSystemId: string;
  sourceSystemName: string;
  externalId: string;
  sourcePriority: number;
  completenessScore: number;
  observedAt: Date;
  normalizationVersion: string;
}

const PERSON_FIELDS: readonly FieldDescriptor[] = [
  { path: 'name', kind: 'display', normalizedKey: 'name' },
  { path: 'email', kind: 'identifier', normalizedKey: 'email' },
  { path: 'phone', kind: 'identifier', normalizedKey: 'phone' },
  { path: 'company', kind: 'display', normalizedKey: 'company', companyName: true },
  { path: 'company_domain', kind: 'identifier', normalizedKey: 'company_domain' },
  { path: 'address.line1', kind: 'display', normalizedKey: 'line1' },
  { path: 'address.city', kind: 'display', normalizedKey: 'city' },
  { path: 'address.region', kind: 'display', normalizedKey: 'region' },
  { path: 'address.postal_code', kind: 'display', normalizedKey: 'postal_code' },
  { path: 'address.country', kind: 'identifier', normalizedKey: 'country' },
];

const COMPANY_FIELDS: readonly FieldDescriptor[] = [
  { path: 'name', kind: 'display', normalizedKey: 'name', companyName: true },
  { path: 'domain', kind: 'identifier', normalizedKey: 'domain' },
  { path: 'email', kind: 'identifier', normalizedKey: 'email' },
  { path: 'phone', kind: 'identifier', normalizedKey: 'phone' },
  { path: 'registration_id', kind: 'registration' },
  { path: 'address.line1', kind: 'display', normalizedKey: 'line1' },
  { path: 'address.city', kind: 'display', normalizedKey: 'city' },
  { path: 'address.region', kind: 'display', normalizedKey: 'region' },
  { path: 'address.postal_code', kind: 'display', normalizedKey: 'postal_code' },
  { path: 'address.country', kind: 'identifier', normalizedKey: 'country' },
];

export function buildCanonicalProjection(
  entityType: EntityType,
  records: readonly CanonicalizationRecord[],
): CanonicalProjection {
  const canonicalData: Record<string, unknown> = {};
  const provenance: Record<string, unknown> = {};
  const fields: CanonicalFieldSelection[] = [];

  for (const record of records) validateNormalizedPayload(entityType, record.normalizedPayload);

  for (const descriptor of fieldsFor(entityType)) {
    const candidates = records
      .map((record) => candidateFor(descriptor, record))
      .filter((candidate): candidate is Candidate => candidate !== null)
      .sort(compareCandidates);
    const winner = candidates[0];
    if (!winner) continue;

    const selection = selectionFor(winner, candidates[1]);
    fields.push(selection);
    addAtPath(canonicalData, selection.fieldPath, selection.canonicalValue);
    addAtPath(provenance, selection.fieldPath, provenanceFor(selection));
  }

  return { canonicalData, provenance, fields };
}

function fieldsFor(entityType: EntityType): readonly FieldDescriptor[] {
  return entityType === EntityType.Person ? PERSON_FIELDS : COMPANY_FIELDS;
}

function candidateFor(
  descriptor: FieldDescriptor,
  record: CanonicalizationRecord,
): Candidate | null {
  const normalized = objectValue(record.normalizedPayload);
  if (!normalized) throw new CanonicalizationDataIntegrityError();
  const raw = objectValue(record.rawPayload);
  if (!raw) return null;

  const rawValue = rawValueFor(descriptor.path, raw);
  if (!rawValue) return null;

  if (descriptor.kind === 'registration') {
    const canonicalValue = rawValue.trim();
    return canonicalValue
      ? makeCandidate(
          descriptor.path,
          canonicalValue,
          rawValue,
          codePointLength(canonicalValue),
          record,
        )
      : null;
  }

  const normalizedValue = normalizedValueFor(descriptor, normalized);
  if (!normalizedValue) return null;

  const canonicalValue =
    descriptor.kind === 'identifier'
      ? normalizedValue
      : descriptor.path === 'address.postal_code'
        ? rawValue.trim()
        : collapseWhitespace(rawValue);
  if (!canonicalValue) return null;

  return makeCandidate(
    descriptor.path,
    canonicalValue,
    rawValue,
    descriptor.kind === 'identifier' ? 1 : codePointLength(normalizedValue),
    record,
  );
}

function normalizedValueFor(
  descriptor: FieldDescriptor,
  payload: Record<string, unknown>,
): string | null {
  const value = descriptor.path.startsWith('address.')
    ? addressValue(payload, descriptor.normalizedKey!)
    : payload[descriptor.normalizedKey!];

  if (descriptor.companyName) return normalizedCompanyName(value);
  return normalizedString(value);
}

function validateNormalizedPayload(entityType: EntityType, payload: unknown): void {
  const normalized = objectValue(payload);
  if (!normalized) throw new CanonicalizationDataIntegrityError();

  if (entityType === EntityType.Person) {
    validateNormalizedString(normalized.name);
    validateNormalizedString(normalized.email);
    validateNormalizedString(normalized.phone);
    validateNormalizedCompanyName(normalized.company);
    validateNormalizedString(normalized.company_domain);
  } else {
    validateNormalizedCompanyName(normalized.name);
    validateNormalizedString(normalized.domain);
    validateNormalizedString(normalized.email);
    validateNormalizedString(normalized.phone);
  }
  validateNormalizedAddress(normalized.address);
}

function validateNormalizedAddress(value: unknown): void {
  if (value === undefined || value === null) return;
  const address = objectValue(value);
  if (!address) throw new CanonicalizationDataIntegrityError();
  validateNormalizedString(address.line1);
  validateNormalizedString(address.city);
  validateNormalizedString(address.region);
  validateNormalizedString(address.postal_code);
  validateNormalizedString(address.country);
}

function validateNormalizedString(value: unknown): void {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new CanonicalizationDataIntegrityError();
  }
}

function validateNormalizedCompanyName(value: unknown): void {
  if (value === undefined || value === null) return;
  const companyName = objectValue(value);
  if (
    !companyName ||
    typeof companyName.full !== 'string' ||
    typeof companyName.base !== 'string' ||
    (companyName.legal_suffix !== null && typeof companyName.legal_suffix !== 'string')
  ) {
    throw new CanonicalizationDataIntegrityError();
  }
}

function addressValue(payload: Record<string, unknown>, key: string): unknown {
  const address = payload.address;
  if (address === undefined || address === null) return null;
  const object = objectValue(address);
  if (!object) throw new CanonicalizationDataIntegrityError();
  return object[key];
}

function rawValueFor(path: FieldPath, payload: Record<string, unknown>): string | null {
  if (!path.startsWith('address.')) return stringValue(payload[path]);
  const address = objectValue(payload.address);
  return address ? stringValue(address[path.slice('address.'.length)]) : null;
}

function normalizedString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new CanonicalizationDataIntegrityError();
  return value.trim() ? value : null;
}

function normalizedCompanyName(value: unknown): string | null {
  validateNormalizedCompanyName(value);
  if (value === undefined || value === null) return null;
  return normalizedString(objectValue(value)?.full);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function makeCandidate(
  fieldPath: FieldPath,
  canonicalValue: string,
  rawValue: string,
  completenessScore: number,
  record: CanonicalizationRecord,
): Candidate {
  return {
    fieldPath,
    canonicalValue,
    rawValue,
    sourceRecordId: record.id,
    sourceSystemId: record.source.id,
    sourceSystemName: record.source.name,
    externalId: record.externalId,
    sourcePriority: record.source.priority,
    completenessScore,
    observedAt: record.updatedAt,
    normalizationVersion: record.normalizationVersion,
  };
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    left.sourcePriority - right.sourcePriority ||
    right.completenessScore - left.completenessScore ||
    right.observedAt.getTime() - left.observedAt.getTime() ||
    left.sourceRecordId.localeCompare(right.sourceRecordId)
  );
}

function selectionFor(
  winner: Candidate,
  runnerUp: Candidate | undefined,
): CanonicalFieldSelection & { fieldPath: FieldPath } {
  return {
    ...winner,
    selectionRule: selectionRuleFor(winner, runnerUp),
    canonicalizationVersion: CANONICALIZATION_VERSION,
  };
}

function selectionRuleFor(
  winner: Candidate,
  runnerUp: Candidate | undefined,
): CanonicalSelectionRule {
  if (!runnerUp) return 'ONLY_CANDIDATE';
  if (winner.sourcePriority !== runnerUp.sourcePriority) return 'SOURCE_PRIORITY';
  if (winner.completenessScore !== runnerUp.completenessScore) return 'COMPLETENESS';
  if (winner.observedAt.getTime() !== runnerUp.observedAt.getTime()) return 'RECENCY';
  return 'STABLE_TIE_BREAK';
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function provenanceFor(field: CanonicalFieldSelection): Omit<CanonicalFieldSelection, 'fieldPath'> {
  return {
    canonicalValue: field.canonicalValue,
    rawValue: field.rawValue,
    sourceRecordId: field.sourceRecordId,
    sourceSystemId: field.sourceSystemId,
    sourceSystemName: field.sourceSystemName,
    externalId: field.externalId,
    sourcePriority: field.sourcePriority,
    selectionRule: field.selectionRule,
    completenessScore: field.completenessScore,
    observedAt: field.observedAt,
    normalizationVersion: field.normalizationVersion,
    canonicalizationVersion: field.canonicalizationVersion,
  };
}

function addAtPath(data: Record<string, unknown>, path: FieldPath, value: unknown): void {
  switch (path) {
    case 'name':
      data.name = value;
      return;
    case 'email':
      data.email = value;
      return;
    case 'phone':
      data.phone = value;
      return;
    case 'company':
      data.company = value;
      return;
    case 'company_domain':
      data.company_domain = value;
      return;
    case 'domain':
      data.domain = value;
      return;
    case 'registration_id':
      data.registration_id = value;
      return;
    case 'address.line1':
      addressTarget(data).line1 = value;
      return;
    case 'address.city':
      addressTarget(data).city = value;
      return;
    case 'address.region':
      addressTarget(data).region = value;
      return;
    case 'address.postal_code':
      addressTarget(data).postal_code = value;
      return;
    case 'address.country':
      addressTarget(data).country = value;
  }
}

function addressTarget(data: Record<string, unknown>): Record<string, unknown> {
  const existing = objectValue(data.address);
  if (existing) return existing;
  const address: Record<string, unknown> = {};
  data.address = address;
  return address;
}
