import 'reflect-metadata';

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_SCOPES, type ApiScope } from '@resolve/contracts';
import { createPrismaClient } from '@resolve/database';

import { generateApiKey, type ApiKeyEnvironment } from './api-key.js';

interface BootstrapArguments {
  environment: ApiKeyEnvironment;
  keyName: string;
  scopes: ApiScope[];
  tenantName: string;
}

export function parseBootstrapArguments(arguments_: string[]): BootstrapArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid bootstrap argument near ${name ?? 'end of input'}`);
    }
    if (values.has(name)) throw new Error(`Duplicate bootstrap argument ${name}`);
    values.set(name, value);
  }
  const allowed = new Set(['--tenant-name', '--environment', '--key-name', '--scopes']);
  for (const name of values.keys())
    if (!allowed.has(name)) throw new Error(`Unknown bootstrap argument ${name}`);

  const tenantName = values.get('--tenant-name')?.trim();
  if (!tenantName) throw new Error('--tenant-name is required');
  const environment = values.get('--environment');
  if (environment !== 'test' && environment !== 'live')
    throw new Error('--environment must be test or live');
  const keyName = values.get('--key-name')?.trim() || 'Bootstrap key';
  const requestedScopes = (values.get('--scopes') ?? API_SCOPES.join(','))
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (
    requestedScopes.length === 0 ||
    requestedScopes.some((scope) => !API_SCOPES.includes(scope as ApiScope))
  ) {
    throw new Error('Every requested scope must be a supported API scope');
  }
  return { environment, keyName, scopes: requestedScopes as ApiScope[], tenantName };
}

async function main(): Promise<void> {
  const options = parseBootstrapArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const prisma = createPrismaClient(databaseUrl);
  const generated = generateApiKey(options.environment);
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const tenant = await transaction.tenant.create({ data: { name: options.tenantName } });
      const apiKey = await transaction.apiKey.create({
        data: {
          tenantId: tenant.id,
          name: options.keyName,
          prefix: generated.prefix,
          keyHash: generated.hash,
          scopes: options.scopes,
        },
      });
      return { apiKeyId: apiKey.id, tenantId: tenant.id };
    });
    console.log(`Tenant ID: ${result.tenantId}`);
    console.log(`API key ID: ${result.apiKeyId}`);
    console.log(`API key (shown once): ${generated.plaintext}`);
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'API-key bootstrap failed');
    process.exitCode = 1;
  });
}
