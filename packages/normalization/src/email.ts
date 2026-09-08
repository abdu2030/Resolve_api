import { normalizeDomain } from './domain.js';
import { normalizeText, type NormalizableValue } from './text.js';

const INVALID_LOCAL_CHARACTER = /[\p{White_Space}\p{Cc}]/u;
const SUPPORTED_LOCAL_PART = /^[A-Za-z0-9!#$%&'*+\-/=?^_{|}~.]+$/u;

export function normalizeEmail(value: NormalizableValue): string | null {
  const prepared = normalizeText(value);
  if (prepared === null) return null;

  const separator = prepared.indexOf('@');
  if (separator <= 0 || separator !== prepared.lastIndexOf('@')) return null;

  const localPart = prepared.slice(0, separator);
  if (
    localPart.length > 64 ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..') ||
    INVALID_LOCAL_CHARACTER.test(localPart) ||
    !SUPPORTED_LOCAL_PART.test(localPart)
  ) {
    return null;
  }

  const domain = normalizeDomain(prepared.slice(separator + 1));
  if (domain === null) return null;
  const normalized = `${localPart}@${domain}`;
  return normalized.length <= 320 ? normalized : null;
}
