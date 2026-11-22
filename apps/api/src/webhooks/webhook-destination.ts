import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

interface WebhookAddress {
  address: string;
  family: 4 | 6;
}

export interface WebhookDestination {
  url: URL;
  addresses: readonly [WebhookAddress, ...WebhookAddress[]];
}

export type WebhookLookup = (hostname: string) => Promise<WebhookAddress[]>;

export class WebhookTransportError extends Error {
  constructor(readonly code: 'UNSAFE_DESTINATION' | 'DNS_UNAVAILABLE' | 'NETWORK_ERROR') {
    super(code);
  }
}

const denied = new BlockList();
const deniedIpv4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const;
for (const [subnet, prefix] of deniedIpv4) denied.addSubnet(subnet, prefix);

const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
const deniedIpv6 = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const;
for (const [subnet, prefix] of deniedIpv6) denied.addSubnet(subnet, prefix, 'ipv6');

const resolver = new Resolver({ timeout: 2000, tries: 1 });

function publicAddress({ address, family }: WebhookAddress): boolean {
  if (isIP(address) !== family) return false;
  return family === 4
    ? !denied.check(address)
    : globalIpv6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}

function parseDestination(value: string): URL {
  const url = URL.parse(value);
  if (
    !url ||
    !/^https:\/\//i.test(value) ||
    /[\s\\#]/u.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    url.username ||
    url.password ||
    !url.hostname.includes('.') ||
    isIP(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|home\.arpa)\.?$/i.test(url.hostname)
  ) {
    throw new WebhookTransportError('UNSAFE_DESTINATION');
  }
  url.hostname = url.hostname.replace(/\.$/, '');
  if (!url.hostname.includes('.')) throw new WebhookTransportError('UNSAFE_DESTINATION');
  return url;
}

function emptyOnMissingFamily(error: unknown): string[] {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENODATA') {
    return [];
  }
  throw error;
}

async function lookupPublicAnswers(hostname: string): Promise<WebhookAddress[]> {
  const [ipv4, ipv6] = await Promise.all([
    resolver.resolve4(hostname).catch(emptyOnMissingFamily),
    resolver.resolve6(hostname).catch(emptyOnMissingFamily),
  ]);
  return [
    ...ipv4.map((address): WebhookAddress => ({ address, family: 4 })),
    ...ipv6.map((address): WebhookAddress => ({ address, family: 6 })),
  ];
}

export async function prepareWebhookDestination(
  value: string,
  lookup: WebhookLookup = lookupPublicAnswers,
): Promise<WebhookDestination> {
  const url = parseDestination(value);
  const answers = await lookup(url.hostname).catch(() => {
    throw new WebhookTransportError('DNS_UNAVAILABLE');
  });
  const [first, ...rest] = answers;
  if (!first) throw new WebhookTransportError('DNS_UNAVAILABLE');
  if (!answers.every(publicAddress)) throw new WebhookTransportError('UNSAFE_DESTINATION');
  return { url, addresses: [first, ...rest] };
}
