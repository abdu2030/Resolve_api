import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';

export type ResolvePrismaClient = PrismaClient;

export function createPrismaClient(databaseUrl: string): ResolvePrismaClient {
  const connectionUrl = new URL(databaseUrl);
  const schema = connectionUrl.searchParams.get('schema') ?? undefined;
  connectionUrl.searchParams.delete('schema');
  const adapter = new PrismaPg(
    { connectionString: connectionUrl.toString() },
    schema ? { schema } : undefined,
  );
  return new PrismaClient({ adapter });
}
