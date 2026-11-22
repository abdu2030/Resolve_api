import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentConfig } from '@resolve/config';

import { ApiException } from '../common/http/api-exception.js';

@Injectable()
export class WebhookSecretService {
  constructor(private readonly config: ConfigService<EnvironmentConfig, true>) {}

  get enabled(): boolean {
    return this.config.get('webhookEncryptionKey', { infer: true }) !== undefined;
  }

  encrypt(secret: string, tenantId: string, endpointId: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(tenantId + ':' + endpointId));
    const encrypted = Buffer.concat([cipher.update(Buffer.from(secret, 'hex')), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  decrypt(value: string, tenantId: string, endpointId: string): Buffer {
    const encrypted = Buffer.from(value, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', this.key(), encrypted.subarray(0, 12));
    cipher.setAAD(Buffer.from(tenantId + ':' + endpointId));
    cipher.setAuthTag(encrypted.subarray(12, 28));
    return Buffer.concat([cipher.update(encrypted.subarray(28)), cipher.final()]);
  }

  private key(): Buffer {
    const key = this.config.get('webhookEncryptionKey', { infer: true });
    if (key === undefined) {
      throw new ApiException(503, 'WEBHOOKS_UNAVAILABLE', 'Webhook signing is unavailable');
    }
    return Buffer.from(key, 'hex');
  }
}
