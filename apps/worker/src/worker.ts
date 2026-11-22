import 'reflect-metadata';
import { ConsoleLogger, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

export function createWorker(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(AppModule, {
    logger: new ConsoleLogger({ json: true }),
  });
}
