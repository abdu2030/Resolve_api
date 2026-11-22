import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ResolvePrismaClient } from '@resolve/database';

import { acquireTransactionLock } from '../common/database/advisory-lock.js';
import { ApiException } from '../common/http/api-exception.js';
import { hashCanonicalJson } from '../common/json/canonical-json.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { WebhookTransportError } from './webhook-destination.js';
import { WebhookSecretService } from './webhook-secret.service.js';
import { WebhookTransport } from './webhook-transport.js';
import type {
  RegisterWebhookEndpointDto,
  WebhookDeliveryDetailDto,
  WebhookDeliveryDto,
  WebhookDeliveryPageDto,
  WebhookEndpointDto,
  WebhookReplayDto,
} from './webhook.dto.js';

const PAGE_SIZE = 25;
const MAX_ENDPOINTS = 25;

@Injectable()
export class WebhookEndpointService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient,
    private readonly transport: WebhookTransport,
    private readonly secrets: WebhookSecretService,
  ) {}

  async register(tenantId: string, input: RegisterWebhookEndpointDto): Promise<WebhookEndpointDto> {
    if (!this.secrets.enabled) {
      throw new ApiException(503, 'WEBHOOKS_UNAVAILABLE', 'Webhook signing is unavailable');
    }
    const destination = await this.transport.resolve(input.url).catch((error: unknown) => {
      if (error instanceof WebhookTransportError) {
        if (error.code === 'UNSAFE_DESTINATION') {
          throw new ApiException(422, 'UNSAFE_WEBHOOK_URL', 'Webhook URL must use public HTTPS');
        }
        throw new ApiException(
          503,
          'WEBHOOK_DNS_UNAVAILABLE',
          'Webhook hostname could not be resolved',
        );
      }
      throw error;
    });
    const url = destination.url.href;
    if (url.length > 2048)
      throw new ApiException(422, 'UNSAFE_WEBHOOK_URL', 'Webhook URL is too long');
    const id = randomUUID();
    const encryptedSecret = this.secrets.encrypt(input.signing_secret, tenantId, id);
    return this.prisma.$transaction(async (transaction) => {
      await acquireTransactionLock(transaction, 'webhook-endpoints:' + tenantId);
      const duplicate = await transaction.webhookEndpoint.findUnique({
        where: { tenantId_url: { tenantId, url } },
        select: { id: true },
      });
      if (duplicate) {
        throw new ApiException(
          409,
          'WEBHOOK_ENDPOINT_EXISTS',
          'Webhook URL is already registered',
          {
            endpoint_id: duplicate.id,
          },
        );
      }
      const count = await transaction.webhookEndpoint.count({ where: { tenantId } });
      if (count >= MAX_ENDPOINTS) {
        throw new ApiException(409, 'WEBHOOK_ENDPOINT_LIMIT', 'Webhook endpoint limit reached');
      }
      const endpoint = await transaction.webhookEndpoint.create({
        data: { id, tenantId, url, events: input.events, encryptedSecret },
        select: { id: true, url: true, events: true, createdAt: true },
      });
      return {
        endpoint_id: endpoint.id,
        url: endpoint.url,
        events: endpoint.events,
        created_at: endpoint.createdAt.toISOString(),
      };
    });
  }

  async list(
    tenantId: string,
    endpointId: string,
    cursor?: string,
  ): Promise<WebhookDeliveryPageDto> {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { tenantId_id: { tenantId, id: endpointId } },
      select: { id: true },
    });
    if (!endpoint)
      throw new ApiException(404, 'WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint does not exist');
    if (cursor) {
      const prior = await this.prisma.webhookDelivery.findFirst({
        where: { tenantId, endpointId, id: cursor },
        select: { id: true },
      });
      if (!prior)
        throw new ApiException(400, 'INVALID_WEBHOOK_CURSOR', 'Webhook delivery cursor is invalid');
    }
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { tenantId, endpointId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 } : {}),
      include: { event: { select: { type: true } } },
    });
    const deliveries = rows.slice(0, PAGE_SIZE).map(mapDelivery);
    return {
      deliveries,
      next_cursor: rows.length > PAGE_SIZE ? deliveries[PAGE_SIZE - 1]!.delivery_id : null,
    };
  }

  async get(
    tenantId: string,
    endpointId: string,
    eventId: string,
  ): Promise<WebhookDeliveryDetailDto> {
    const delivery = await this.prisma.$transaction(
      (transaction) =>
        transaction.webhookDelivery.findUnique({
          where: { tenantId_endpointId_eventId: { tenantId, endpointId, eventId } },
          include: {
            event: { select: { type: true } },
            attemptHistory: { orderBy: { number: 'desc' }, take: 50 },
          },
        }),
      { isolationLevel: 'RepeatableRead' },
    );
    if (!delivery) throw deliveryNotFound();
    return {
      ...mapDelivery(delivery),
      attempt_history: delivery.attemptHistory.map((attempt) => ({
        number: attempt.number,
        outcome: attempt.outcome,
        http_status: attempt.httpStatus,
        error_code: attempt.errorCode,
        started_at: attempt.startedAt.toISOString(),
        finished_at: attempt.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  replay(
    tenantId: string,
    endpointId: string,
    eventId: string,
    key: string,
  ): Promise<{ body: WebhookReplayDto; replayed: boolean }> {
    const operation = 'POST /v1/webhook-endpoints/:endpointId/deliveries/:eventId/replay';
    const requestHash = hashCanonicalJson({ endpointId, eventId });
    return this.prisma.$transaction(async (transaction) => {
      await acquireTransactionLock(transaction, 'idempotency:' + tenantId + ':' + key);
      const prior = await transaction.idempotencyRequest.findUnique({
        where: { tenantId_key: { tenantId, key } },
      });
      if (prior) {
        if (prior.operation !== operation || prior.requestHash !== requestHash) {
          throw new ApiException(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used for a different request',
          );
        }
        return { body: prior.responseBody as unknown as WebhookReplayDto, replayed: true };
      }
      const delivery = await transaction.webhookDelivery.findUnique({
        where: { tenantId_endpointId_eventId: { tenantId, endpointId, eventId } },
        select: { id: true, attempts: true },
      });
      if (!delivery) throw deliveryNotFound();
      const queued = await transaction.webhookDelivery.updateMany({
        where: {
          tenantId,
          id: delivery.id,
          attempts: delivery.attempts,
          status: { in: ['DELIVERED', 'DEAD_LETTER'] },
        },
        data: {
          status: 'PENDING',
          availableAt: new Date(),
          finishedAt: null,
          lastError: null,
          replayStartAttempt: delivery.attempts,
        },
      });
      if (!queued.count) {
        throw new ApiException(
          409,
          'WEBHOOK_DELIVERY_ACTIVE',
          'Webhook delivery already has work pending',
        );
      }
      const body: WebhookReplayDto = {
        delivery_id: delivery.id,
        event_id: eventId,
        status: 'PENDING',
      };
      await transaction.idempotencyRequest.create({
        data: {
          tenantId,
          key,
          operation,
          requestHash,
          responseStatus: 202,
          responseBody: { ...body },
        },
      });
      return { body, replayed: false };
    });
  }
}

function deliveryNotFound(): ApiException {
  return new ApiException(404, 'WEBHOOK_DELIVERY_NOT_FOUND', 'Webhook delivery does not exist');
}

function mapDelivery(row: {
  id: string;
  eventId: string;
  event: { type: string };
  status: WebhookDeliveryDto['status'];
  attempts: number;
  lastError: string | null;
  finishedAt: Date | null;
  createdAt: Date;
}): WebhookDeliveryDto {
  return {
    delivery_id: row.id,
    event_id: row.eventId,
    type: row.event.type,
    status: row.status,
    attempts: row.attempts,
    last_error: row.lastError,
    finished_at: row.finishedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
