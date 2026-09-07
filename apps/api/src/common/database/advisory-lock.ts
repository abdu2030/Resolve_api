import type { Prisma } from '@resolve/database';

export async function acquireTransactionLock(
  transaction: Prisma.TransactionClient,
  identity: string,
): Promise<void> {
  await transaction.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
}
