import { createHmac } from 'node:crypto';
import { request, type RequestOptions } from 'node:https';
import type { TcpNetConnectOpts } from 'node:net';
import { Injectable } from '@nestjs/common';

import {
  prepareWebhookDestination,
  WebhookTransportError,
  type WebhookDestination,
} from './webhook-destination.js';

export function signWebhook(secret: Buffer, timestamp: string, body: Buffer): string {
  return (
    'v1=' +
    createHmac('sha256', secret)
      .update(timestamp + '.')
      .update(body)
      .digest('hex')
  );
}

export function retryableWebhookStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

@Injectable()
export class WebhookTransport {
  resolve(url: string): Promise<WebhookDestination> {
    return prepareWebhookDestination(url);
  }

  async send(url: string, body: Buffer, secret: Buffer): Promise<number> {
    const destination = await this.resolve(url);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return new Promise((resolve, reject) => {
      // The validated IP is used for the socket. The URL hostname still controls TLS verification.
      const options: RequestOptions & Pick<TcpNetConnectOpts, 'autoSelectFamily'> = {
        method: 'POST',
        agent: false,
        autoSelectFamily: true,
        lookup: (_hostname, options, callback) => {
          if (options.all) return callback(null, [...destination.addresses]);
          const { address, family } = destination.addresses[0];
          callback(null, address, family);
        },
        signal: AbortSignal.timeout(5000),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'Resolve-Timestamp': timestamp,
          'Resolve-Signature': signWebhook(secret, timestamp, body),
        },
      };
      const outgoing = request(destination.url, options, (incoming) => {
        resolve(incoming.statusCode ?? 502);
        // Status is the whole acknowledgement. The peer controls the size of the body.
        incoming.destroy();
      });
      outgoing.once('error', () => reject(new WebhookTransportError('NETWORK_ERROR')));
      outgoing.end(body);
    });
  }
}
