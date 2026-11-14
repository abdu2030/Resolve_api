import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

export function createWorker(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(AppModule);
}
