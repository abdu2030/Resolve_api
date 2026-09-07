import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import type { EnvironmentConfig } from '@resolve/config';

import { createApplication } from './application.js';

async function bootstrap(): Promise<void> {
  const app = await createApplication();
  const config = app.get(ConfigService<EnvironmentConfig, true>);
  await app.listen(config.get('apiPort', { infer: true }));
}

void bootstrap();
