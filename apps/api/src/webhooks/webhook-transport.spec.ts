import { createHmac } from 'node:crypto';

import { prepareWebhookDestination, type WebhookLookup } from './webhook-destination.js';
import { retryableWebhookStatus, signWebhook } from './webhook-transport.js';

const publicLookup: WebhookLookup = () =>
  Promise.resolve([{ address: '93.184.215.14', family: 4 }]);

describe('webhook destination validation', () => {
  it('pins the validated addresses and preserves the HTTPS host and path', async () => {
    const destination = await prepareWebhookDestination(
      'https://example.com/events?q=1',
      publicLookup,
    );
    expect(destination).toEqual({
      url: new URL('https://example.com/events?q=1'),
      addresses: [{ address: '93.184.215.14', family: 4 }],
    });
  });

  it.each([
    'http://example.com/events',
    'https://example.com@other.example/events',
    'https://example.com/events#reply',
    'https://localhost/events',
    'https://127.0.0.1/events',
  ])('rejects a destination outside the public HTTPS contract', async (url) => {
    await expect(prepareWebhookDestination(url, publicLookup)).rejects.toMatchObject({
      code: 'UNSAFE_DESTINATION',
    });
  });

  it.each([
    { address: '10.0.0.1', family: 4 },
    { address: '169.254.0.1', family: 4 },
    { address: '::ffff:192.0.2.1', family: 6 },
    { address: 'fd00::1', family: 6 },
  ] as const)('rejects an unsafe DNS answer even alongside a public answer', async (answer) => {
    await expect(
      prepareWebhookDestination('https://example.com', async () => [
        ...(await publicLookup('example.com')),
        answer,
      ]),
    ).rejects.toMatchObject({ code: 'UNSAFE_DESTINATION' });
  });

  it('uses a distinct code for DNS failure', async () => {
    await expect(
      prepareWebhookDestination('https://example.com', () => Promise.resolve([])),
    ).rejects.toMatchObject({ code: 'DNS_UNAVAILABLE' });
  });
});

describe('webhook signing and HTTP outcomes', () => {
  it('signs the timestamp and exact body bytes with HMAC-SHA256', () => {
    const secret = Buffer.alloc(32, 7);
    const body = Buffer.from('{"event_id":"the-event","data":{"label":"Eré"}}');
    const timestamp = '1795329509';
    const expected = createHmac('sha256', secret)
      .update(timestamp + '.')
      .update(body)
      .digest('hex');
    expect(signWebhook(secret, timestamp, body)).toBe('v1=' + expected);
    expect(signWebhook(secret, timestamp, Buffer.from(body.toString() + ' '))).not.toBe(
      'v1=' + expected,
    );
  });

  it('allows only timeout, throttling, and server HTTP responses to retry', () => {
    expect([200, 302, 400, 408, 429, 503].filter(retryableWebhookStatus)).toEqual([408, 429, 503]);
  });
});
