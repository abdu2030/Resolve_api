import { type ContradictionEvidence, type EntityType } from '@resolve/contracts';
import { normalizeText } from '@resolve/normalization';

import { addressCountryEquality, addressTokenSimilarity } from './address.js';
import { domainEquality } from './domain.js';
import { editSimilarity } from './edit-similarity.js';
import { EntityTypeMismatchError } from './entity-type-mismatch.error.js';
import { exactEquality } from './exact.js';
import {
  FEATURE_VERSION,
  type CompanyFeatures,
  type ComparisonRecord,
  type FeatureExtractionResult,
  type PersonFeatures,
} from './features.js';
import { jaroWinklerSimilarity } from './jaro-winkler.js';
import { tokenSimilarity } from './token-similarity.js';

const PERSON_ENTITY_TYPE = 'person' satisfies `${EntityType.Person}` as EntityType.Person;
const COMPANY_ENTITY_TYPE = 'company' satisfies `${EntityType.Company}` as EntityType.Company;

type PersonFeatureExtractionResult = Extract<
  FeatureExtractionResult,
  { entityType: EntityType.Person }
>;
type CompanyFeatureExtractionResult = Extract<
  FeatureExtractionResult,
  { entityType: EntityType.Company }
>;

export function extractFeatures(
  left: ComparisonRecord,
  right: ComparisonRecord,
): FeatureExtractionResult {
  if (left.entityType !== right.entityType) {
    throw new EntityTypeMismatchError(left.entityType, right.entityType);
  }

  return left.entityType === PERSON_ENTITY_TYPE
    ? extractPersonFeatures(left, right)
    : extractCompanyFeatures(left, right);
}

function extractPersonFeatures(
  left: ComparisonRecord,
  right: ComparisonRecord,
): PersonFeatureExtractionResult {
  const leftPayload = left.normalizedPayload;
  const rightPayload = right.normalizedPayload;
  const leftAddress = readAddress(leftPayload);
  const rightAddress = readAddress(rightPayload);
  const features: PersonFeatures = {
    email_exact: exactEquality(readString(leftPayload, 'email'), readString(rightPayload, 'email')),
    phone_exact: exactEquality(readString(leftPayload, 'phone'), readString(rightPayload, 'phone')),
    name_edit_similarity: editSimilarity(
      readString(leftPayload, 'name'),
      readString(rightPayload, 'name'),
    ),
    name_jaro_winkler_similarity: jaroWinklerSimilarity(
      readString(leftPayload, 'name'),
      readString(rightPayload, 'name'),
    ),
    company_name_token_similarity: tokenSimilarity(
      readCompanyBase(leftPayload, 'company'),
      readCompanyBase(rightPayload, 'company'),
    ),
    company_domain_exact: domainEquality(
      readString(leftPayload, 'company_domain'),
      readString(rightPayload, 'company_domain'),
    ),
    address_token_similarity: addressTokenSimilarity(leftAddress, rightAddress),
    country_exact: addressCountryEquality(leftAddress, rightAddress),
  };

  return {
    featureVersion: FEATURE_VERSION,
    entityType: PERSON_ENTITY_TYPE,
    features,
    contradictions: warningContradictions(
      features.email_exact,
      features.phone_exact,
      features.company_domain_exact,
      features.country_exact,
      'company_domain',
    ),
  };
}

function extractCompanyFeatures(
  left: ComparisonRecord,
  right: ComparisonRecord,
): CompanyFeatureExtractionResult {
  const leftPayload = left.normalizedPayload;
  const rightPayload = right.normalizedPayload;
  const leftAddress = readAddress(leftPayload);
  const rightAddress = readAddress(rightPayload);
  const leftName = readCompanyBase(leftPayload, 'name');
  const rightName = readCompanyBase(rightPayload, 'name');
  const features: CompanyFeatures = {
    email_exact: exactEquality(readString(leftPayload, 'email'), readString(rightPayload, 'email')),
    phone_exact: exactEquality(readString(leftPayload, 'phone'), readString(rightPayload, 'phone')),
    company_name_edit_similarity: editSimilarity(leftName, rightName),
    company_name_jaro_winkler_similarity: jaroWinklerSimilarity(leftName, rightName),
    company_name_token_similarity: tokenSimilarity(leftName, rightName),
    domain_exact: domainEquality(
      readString(leftPayload, 'domain'),
      readString(rightPayload, 'domain'),
    ),
    address_token_similarity: addressTokenSimilarity(leftAddress, rightAddress),
    country_exact: addressCountryEquality(leftAddress, rightAddress),
    registration_id_exact: exactEquality(
      prepareRegistrationId(left.rawPayload.registration_id),
      prepareRegistrationId(right.rawPayload.registration_id),
    ),
  };
  const contradictions = warningContradictions(
    features.email_exact,
    features.phone_exact,
    features.domain_exact,
    features.country_exact,
    'domain',
  );

  if (features.registration_id_exact === false) {
    contradictions.push({
      code: 'REGISTRATION_ID_CONFLICT',
      field: 'registration_id',
      message: 'Both records contain different company registration identifiers.',
      severity: 'blocking',
    });
  }

  return {
    featureVersion: FEATURE_VERSION,
    entityType: COMPANY_ENTITY_TYPE,
    features,
    contradictions,
  };
}

function warningContradictions(
  emailExact: boolean | null,
  phoneExact: boolean | null,
  domainExact: boolean | null,
  countryExact: boolean | null,
  domainField: 'company_domain' | 'domain',
): ContradictionEvidence[] {
  const warnings = [
    [
      emailExact,
      'EMAIL_CONFLICT',
      'email',
      'Both records contain different normalized email values.',
    ],
    [
      phoneExact,
      'PHONE_CONFLICT',
      'phone',
      'Both records contain different normalized phone values.',
    ],
    [
      domainExact,
      'COMPANY_DOMAIN_CONFLICT',
      domainField,
      'Both records contain different normalized company domain values.',
    ],
    [
      countryExact,
      'COUNTRY_CONFLICT',
      'address.country',
      'Both records contain different country values.',
    ],
  ] as const;

  return warnings.flatMap(([isExact, code, field, message]) =>
    isExact === false ? [{ code, field, message, severity: 'warning' as const }] : [],
  );
}

function prepareRegistrationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return normalizeText(value)?.toLowerCase() ?? null;
}

function readString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCompanyBase(
  payload: Record<string, unknown>,
  field: 'company' | 'name',
): string | null {
  const company = readRecord(payload[field]);
  return company === null ? null : readString(company, 'base');
}

function readAddress(payload: Record<string, unknown>): Record<string, unknown> | null {
  return readRecord(payload.address);
}
