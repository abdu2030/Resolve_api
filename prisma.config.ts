import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnvironment } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
loadEnvironment({ path: resolve(repositoryRoot, '.env'), quiet: true });

export default defineConfig({
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'packages/database/prisma/migrations',
  },
  schema: 'packages/database/prisma/schema.prisma',
});
