import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { EnvironmentConfig } from '@resolve/config';

import { AppModule } from './app.module.js';
import { configureApplication } from './bootstrap.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService<EnvironmentConfig, true>);
  configureApplication(app, config.get('requestBodyLimit', { infer: true }));
  await app.listen(config.get('apiPort', { infer: true }));
}

void bootstrap();
