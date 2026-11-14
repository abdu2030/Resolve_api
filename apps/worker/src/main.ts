import { createWorker } from './worker.js';

async function bootstrap(): Promise<void> {
  const app = await createWorker();
  app.enableShutdownHooks();
}

void bootstrap();
