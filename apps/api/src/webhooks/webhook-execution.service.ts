import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentConfig } from '@resolve/config';
import type { Prisma, ResolvePrismaClient } from '@resolve/database';

import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { WebhookTransportError } from './webhook-destination.js';
import { WebhookSecretService } from './webhook-secret.service.js';
import { retryableWebhookStatus, WebhookTransport } from './webhook-transport.js';

const LEASE_MS = 30_000;
const DISPATCH_LIMIT = 25;

export interface WebhookDispatch {
  tenantId: string;
  id: string;
  attempts: number;
}

const claimRelations = {
  event: true,
  endpoint: {
    select: { id: true, url: true, encryptedSecret: true, tenant: { select: { status: true } } },
  },
} as const satisfies Prisma.WebhookDeliveryInclude;

type DeliveryContext = Prisma.WebhookDeliveryGetPayload<{ include: typeof claimRelations }>;

interface WebhookClaim {
  number: number;
  attemptsInCycle: number;
  event: DeliveryContext['event'];
  endpoint: DeliveryContext['endpoint'];
  tenantActive: boolean;
}

interface SendResult {
  outcome: 'DELIVERED' | 'FAILED';
  httpStatus: number | null;
  errorCode: string | null;
  retryable: boolean;
}

@Injectable()
export class WebhookExecutionService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient,
    private readonly secrets: WebhookSecretService,
    private readonly transport: WebhookTransport,
    private readonly config: ConfigService<EnvironmentConfig, true>,
  ) {}

  private get maxAttempts(): number {
    return this.config.get('webhookMaxAttempts', { infer: true });
  }

  get enabled(): boolean {
    return this.secrets.enabled;
  }

  dueDeliveries(): Promise<WebhookDispatch[]> {
    // This scan drives the internal dispatcher across tenants. A claim always uses the tenant ID.
    return this.prisma.webhookDelivery.findMany({
      where: { status: { in: ['PENDING', 'RUNNING'] }, availableAt: { lte: new Date() } },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      select: { tenantId: true, id: true, attempts: true },
      take: DISPATCH_LIMIT,
    });
  }

  async process(dispatch: WebhookDispatch): Promise<void> {
    const claim = await this.claim(dispatch);
    if (!claim) return;
    let result: SendResult;
    if (!claim.tenantActive) {
      result = failure('TENANT_INACTIVE', false);
    } else {
      const body = Buffer.from(
        JSON.stringify({
          event_id: claim.event.id,
          type: claim.event.type,
          occurred_at: claim.event.occurredAt.toISOString(),
          data: claim.event.data,
        }),
      );
      result = await this.send(claim.endpoint, dispatch.tenantId, body);
    }
    const now = new Date();
    const retry = result.retryable && claim.attemptsInCycle < this.maxAttempts;
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.webhookDelivery.updateMany({
        where: {
          tenantId: dispatch.tenantId,
          id: dispatch.id,
          status: 'RUNNING',
          attempts: claim.number,
        },
        data: {
          status: retry ? 'PENDING' : result.outcome === 'DELIVERED' ? 'DELIVERED' : 'DEAD_LETTER',
          availableAt: retry
            ? new Date(
                now.getTime() +
                  backoffMs(
                    claim.attemptsInCycle,
                    this.config.get('webhookRetryBaseMs', { infer: true }),
                  ),
              )
            : now,
          finishedAt: retry ? null : now,
          lastError: result.errorCode,
        },
      });
      if (!updated.count) return;
      await transaction.webhookAttempt.update({
        where: {
          tenantId_deliveryId_number: {
            tenantId: dispatch.tenantId,
            deliveryId: dispatch.id,
            number: claim.number,
          },
        },
        data: {
          outcome: result.outcome,
          httpStatus: result.httpStatus,
          errorCode: result.errorCode,
          finishedAt: now,
        },
      });
    });
  }

  private claim({ tenantId, id, attempts }: WebhookDispatch): Promise<WebhookClaim | undefined> {
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const delivery = await transaction.webhookDelivery.findUnique({
        where: { tenantId_id: { tenantId, id } },
        include: claimRelations,
      });
      if (
        !delivery ||
        delivery.attempts !== attempts ||
        delivery.availableAt > now ||
        (delivery.status !== 'PENDING' && delivery.status !== 'RUNNING')
      )
        return;

      const number = attempts + 1;
      const attemptsInCycle = number - delivery.replayStartAttempt;
      const exhausted = attemptsInCycle > this.maxAttempts;
      // The attempt number fences stale workers once their lease expires.
      const updated = await transaction.webhookDelivery.updateMany({
        where: { tenantId, id, attempts, status: delivery.status, availableAt: { lte: now } },
        data: exhausted
          ? { status: 'DEAD_LETTER', finishedAt: now, lastError: 'DELIVERY_INTERRUPTED' }
          : {
              status: 'RUNNING',
              attempts: number,
              availableAt: new Date(now.getTime() + LEASE_MS),
            },
      });
      if (!updated.count) return;
      if (delivery.status === 'RUNNING') {
        await transaction.webhookAttempt.update({
          where: { tenantId_deliveryId_number: { tenantId, deliveryId: id, number: attempts } },
          data: { outcome: 'INTERRUPTED', finishedAt: now, errorCode: 'DELIVERY_INTERRUPTED' },
        });
      }
      if (exhausted) return;
      await transaction.webhookAttempt.create({
        data: { tenantId, deliveryId: id, number, startedAt: now },
      });
      return {
        number,
        attemptsInCycle,
        event: delivery.event,
        endpoint: delivery.endpoint,
        tenantActive: delivery.endpoint.tenant.status === 'ACTIVE',
      };
    });
  }

  private async send(
    endpoint: { id: string; url: string; encryptedSecret: string },
    tenantId: string,
    body: Buffer,
  ): Promise<SendResult> {
    let secret: Buffer;
    try {
      secret = this.secrets.decrypt(endpoint.encryptedSecret, tenantId, endpoint.id);
    } catch {
      return failure('SIGNING_UNAVAILABLE', true);
    }
    try {
      const status = await this.transport.send(endpoint.url, body, secret);
      if (status >= 200 && status < 300) {
        return { outcome: 'DELIVERED', httpStatus: status, errorCode: null, retryable: false };
      }
      const code = status >= 300 && status < 400 ? 'HTTP_REDIRECT' : 'HTTP_FAILURE';
      return { ...failure(code, retryableWebhookStatus(status)), httpStatus: status };
    } catch (error) {
      const code = error instanceof WebhookTransportError ? error.code : 'NETWORK_ERROR';
      return failure(code, code !== 'UNSAFE_DESTINATION');
    } finally {
      secret.fill(0);
    }
  }
}

function failure(errorCode: string, retryable: boolean): SendResult {
  return { outcome: 'FAILED', httpStatus: null, errorCode, retryable };
}

function backoffMs(attempt: number, baseMs: number): number {
  const base = baseMs * 2 ** (attempt - 1);
  return base + Math.floor((Math.random() * base) / 4);
}
