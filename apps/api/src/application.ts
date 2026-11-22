import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { EnvironmentConfig } from '@resolve/config';

import { AppModule } from './app.module.js';
import { configureApplication } from './bootstrap.js';
import { HttpObservabilityService } from './observability/http-observability.service.js';

export type ResolveApplication = INestApplication;

export async function createApplication(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: new ConsoleLogger({ json: true }),
  });
  const config = app.get(ConfigService<EnvironmentConfig, true>);
  configureApplication(
    app,
    config.get('requestBodyLimit', { infer: true }),
    app.get(HttpObservabilityService),
  );
  return app;
}
