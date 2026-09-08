import { normalizeText, type NormalizableValue } from './text.js';

const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const HTTP_SCHEME = /^https?:\/\//iu;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

export function normalizeDomain(value: NormalizableValue): string | null {
  const prepared = normalizeText(value);
  if (prepared === null) return null;

  const hasScheme = SCHEME.test(prepared);
  if (hasScheme && !HTTP_SCHEME.test(prepared)) return null;

  const bareValue = hasScheme ? null : prepared.endsWith('/') ? prepared.slice(0, -1) : prepared;
  if (bareValue !== null && (bareValue.length === 0 || /[/?#@:]/u.test(bareValue))) {
    return null;
  }

  try {
    if (hasScheme) {
      const authority = prepared.slice(prepared.indexOf('//') + 2).split(/[/?#]/u)[0] ?? '';
      if (authority.includes('@') || authority.includes(':')) return null;
    }

    const parsed = new URL(hasScheme ? prepared : `http://${bareValue ?? ''}`);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.pathname !== '/'
    ) {
      return null;
    }

    let hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, '');
    if (hostname.startsWith('www.')) hostname = hostname.slice(4);
    return isCompanyHostname(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

function isCompanyHostname(hostname: string): boolean {
  if (
    hostname.length > 253 ||
    !hostname.includes('.') ||
    hostname.includes(':') ||
    IPV4.test(hostname)
  ) {
    return false;
  }
  return hostname.split('.').every((label) => DNS_LABEL.test(label));
}
