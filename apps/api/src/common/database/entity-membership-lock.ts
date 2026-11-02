import type { Prisma } from '@resolve/database';

import { acquireTransactionLock } from './advisory-lock.js';

export async function acquireEntityMembershipLock(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  const identity = `entity-membership:${tenantId}`;
  if (mode === 'exclusive') {
    await acquireTransactionLock(transaction, identity);
    return;
  }
  await transaction.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock_shared(hashtextextended(${identity}, 0))`;
}
