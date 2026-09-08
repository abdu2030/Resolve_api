import { createRequire } from 'node:module';

import type * as PhoneNumberLibrary from 'libphonenumber-js';

import { normalizeText, type NormalizableValue } from './text.js';

const require = createRequire(import.meta.url);
const { isSupportedCountry, parsePhoneNumberFromString } =
  require('libphonenumber-js') as typeof PhoneNumberLibrary;

export function normalizePhone(
  value: NormalizableValue,
  country?: NormalizableValue,
): string | null {
  const prepared = normalizeText(value);
  if (prepared === null) return null;

  const preparedCountry = normalizeText(country)?.toUpperCase() ?? null;
  const countryCode =
    preparedCountry !== null &&
    /^[A-Z]{2}$/u.test(preparedCountry) &&
    isSupportedCountry(preparedCountry)
      ? preparedCountry
      : null;

  try {
    const parsed = prepared.startsWith('+')
      ? parsePhoneNumberFromString(prepared)
      : countryCode !== null
        ? parsePhoneNumberFromString(prepared, countryCode)
        : undefined;
    return parsed?.isValid() === true ? parsed.number : null;
  } catch {
    return null;
  }
}
