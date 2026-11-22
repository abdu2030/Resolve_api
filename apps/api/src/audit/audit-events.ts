import type { ReviewOutcome } from '@resolve/contracts';
import type { Prisma } from '@resolve/database';

type AuditEvent = { tenantId: string; resourceId: string } & (
  | { action: 'API_KEY_BOOTSTRAPPED'; actorApiKeyId?: never; data?: never }
  | ({ actorApiKeyId: string } & (
      | { action: 'SOURCE_REGISTERED' | 'WEBHOOK_ENDPOINT_REGISTERED'; data?: never }
      | {
          action: 'REVIEW_RESOLVED';
          data: { review_decision_id: string; decision: ReviewOutcome };
        }
      | {
          action: 'ENTITY_MERGED' | 'ENTITY_SPLIT' | 'ENTITY_MERGE_REVERSED';
          data: { operation_id: string; source_entity_id: string; target_entity_id: string };
        }
      | {
          action: 'WEBHOOK_DELIVERY_REPLAYED';
          data: { endpoint_id: string; event_id: string };
        }
    ))
);

export async function appendAuditEvent(
  transaction: Prisma.TransactionClient,
  event: AuditEvent,
): Promise<void> {
  await transaction.auditEvent.create({ data: event, select: { id: true } });
}
