import type { Prisma } from '@resolve/database';

export const WEBHOOK_EVENTS = [
  'record.resolved',
  'review.resolved',
  'entity.merged',
  'entity.split',
  'entity.merge_reversed',
  'job.completed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export async function publishWebhookEvent(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  type: WebhookEventType,
  data: Prisma.InputJsonObject,
): Promise<void> {
  const endpoints = await transaction.webhookEndpoint.findMany({
    where: { tenantId, events: { has: type } },
    select: { id: true },
  });
  if (endpoints.length === 0) return;

  const event = await transaction.webhookEvent.create({
    data: { tenantId, type, data },
    select: { id: true },
  });
  await transaction.webhookDelivery.createMany({
    data: endpoints.map(({ id }) => ({ tenantId, endpointId: id, eventId: event.id })),
  });
}
