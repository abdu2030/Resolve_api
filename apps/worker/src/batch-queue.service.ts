import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  BATCH_MAX_ATTEMPTS,
  BatchExecutionService,
  ConfigService,
  type BatchIdentity,
} from '@resolve/api/batch-worker';
import type { EnvironmentConfig } from '@resolve/config';
import { Queue, Worker } from 'bullmq';

export const BATCH_QUEUE = 'batch-resolution';
const POLL_MS = 1000;

@Injectable()
export class BatchQueueService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(BatchQueueService.name);
  private queue?: Queue<BatchIdentity>;
  private worker?: Worker<BatchIdentity, void>;
  private timer?: NodeJS.Timeout;
  private dispatching?: Promise<void>;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<EnvironmentConfig, true>,
    @Inject(BatchExecutionService) private readonly batches: BatchExecutionService,
  ) {}

  onApplicationBootstrap(): void {
    const prefix = this.config.get('batchQueuePrefix', { infer: true });
    const connection = {
      host: this.config.get('redisHost', { infer: true }),
      port: this.config.get('redisPort', { infer: true }),
    };
    this.queue = new Queue<BatchIdentity>(BATCH_QUEUE, {
      prefix,
      connection: {
        ...connection,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: 5000,
      },
      defaultJobOptions: {
        attempts: BATCH_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: { age: 604800, count: 1000 },
      },
    });
    this.worker = new Worker<BatchIdentity, void>(
      BATCH_QUEUE,
      async ({ data }) => {
        try {
          await this.batches.process(data);
        } catch {
          throw new Error('Batch processing attempt failed');
        }
      },
      { prefix, connection },
    );
    this.queue.on('error', () => this.logger.warn('Batch queue connection error'));
    this.worker.on('error', () => this.logger.warn('Batch worker connection error'));
    this.worker.on('stalled', () => this.logger.warn('Batch delivery stalled'));
    const queue = this.queue;
    // Its client promise can remain pending until Redis is reachable.
    void queue
      .waitUntilReady()
      .then(() => {
        if (this.queue !== queue) return;
        this.timer = setInterval(() => this.poll(), POLL_MS);
        this.poll();
      })
      .catch(() => this.logger.warn('Batch queue initialization failed'));
  }

  async beforeApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    const queue = this.queue;
    delete this.queue;
    try {
      await this.dispatching;
      await this.worker?.close();
    } finally {
      await queue?.close();
    }
  }

  private poll(): void {
    if (this.dispatching || !this.queue) return;
    this.dispatching = this.dispatch(this.queue)
      .catch(() => this.logger.warn('Batch dispatch will retry'))
      .finally(() => {
        delete this.dispatching;
      });
  }

  private async dispatch(queue: Queue<BatchIdentity>): Promise<void> {
    // Avoid claiming rows while the producer cannot accept commands.
    if ((await queue.client).status !== 'ready') return;
    for (const identity of await this.batches.dueJobs()) {
      const existing = await queue.getJob(identity.id);
      if (!existing) {
        await queue.add('resolve', identity, { jobId: identity.id });
      } else if (await existing.isFailed()) {
        await this.batches.markDeliveryFailed(identity);
      }
    }
  }
}
