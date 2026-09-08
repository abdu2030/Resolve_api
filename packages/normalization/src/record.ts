import { normalizeAddress, type NormalizedAddress } from './address.js';
import { normalizeCompanyName } from './company.js';
import { normalizeDomain } from './domain.js';
import { normalizeEmail } from './email.js';
import { normalizeName } from './name.js';
import { normalizePhone } from './phone.js';

export const NORMALIZATION_VERSION = 'normalization-v1' as const;

export interface NormalizedRecord {
  normalization_version: typeof NORMALIZATION_VERSION;
  normalized_payload: Record<string, unknown>;
  normalized_email: string | null;
  normalized_phone: string | null;
  company_domain: string | null;
  normalized_name_prefix: string | null;
}

export function normalizeRecord(
  entityType: 'person' | 'company',
  rawData: Record<string, unknown>,
): NormalizedRecord {
  const addressInput = recordValue(rawData.address);
  const address = normalizeAddress(addressInput);
  const country = stringValue(addressInput?.country);
  const email = normalizeEmail(stringValue(rawData.email));
  const phone = normalizePhone(stringValue(rawData.phone), country);

  if (entityType === 'company') {
    return normalizeCompanyRecord(rawData, email, phone, address);
  }

  return normalizePersonRecord(rawData, email, phone, address);
}

function normalizePersonRecord(
  rawData: Record<string, unknown>,
  email: string | null,
  phone: string | null,
  address: NormalizedAddress | null,
): NormalizedRecord {
  const name = normalizeName(stringValue(rawData.name));
  const company = normalizeCompanyName(stringValue(rawData.company));
  const companyDomain = normalizeDomain(stringValue(rawData.company_domain));

  return {
    normalization_version: NORMALIZATION_VERSION,
    normalized_payload: {
      name,
      email,
      phone,
      company,
      company_domain: companyDomain,
      address,
    },
    normalized_email: email,
    normalized_phone: phone,
    company_domain: companyDomain,
    normalized_name_prefix: namePrefix(name),
  };
}

function normalizeCompanyRecord(
  rawData: Record<string, unknown>,
  email: string | null,
  phone: string | null,
  address: NormalizedAddress | null,
): NormalizedRecord {
  const name = normalizeCompanyName(stringValue(rawData.name));
  const domain = normalizeDomain(stringValue(rawData.domain));

  return {
    normalization_version: NORMALIZATION_VERSION,
    normalized_payload: {
      name,
      domain,
      email,
      phone,
      address,
    },
    normalized_email: email,
    normalized_phone: phone,
    company_domain: domain,
    normalized_name_prefix: namePrefix(name?.full ?? null),
  };
}

function namePrefix(value: string | null): string | null {
  return value === null ? null : Array.from(value).slice(0, 64).join('');
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
