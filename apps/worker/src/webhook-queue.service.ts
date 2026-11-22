import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@resolve/api/batch-worker';
import { WebhookExecutionService, type WebhookDispatch } from '@resolve/api/webhook-worker';
import type { EnvironmentConfig } from '@resolve/config';
import { Queue, Worker } from 'bullmq';

const QUEUE_NAME = 'webhook-delivery';

@Injectable()
export class WebhookQueueService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WebhookQueueService.name);
  private queue?: Queue<WebhookDispatch>;
  private worker?: Worker<WebhookDispatch, void>;
  private timer?: NodeJS.Timeout;
  private dispatching?: Promise<void>;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<EnvironmentConfig, true>,
    @Inject(WebhookExecutionService) private readonly webhooks: WebhookExecutionService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.webhooks.enabled) this.connect();
  }

  private connect(): void {
    const prefix = this.config.get('batchQueuePrefix', { infer: true });
    const connection = {
      host: this.config.get('redisHost', { infer: true }),
      port: this.config.get('redisPort', { infer: true }),
    };
    const queue = new Queue<WebhookDispatch>(QUEUE_NAME, {
      prefix,
      connection: {
        ...connection,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: 5000,
      },
      // PostgreSQL owns deadlines, retry counts, and dead-letter state across Redis loss.
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
    });
    this.queue = queue;
    const worker = new Worker<WebhookDispatch, void>(
      QUEUE_NAME,
      async ({ data }) => {
        try {
          await this.webhooks.process(data);
        } catch {
          throw new Error('Webhook processing attempt failed');
        }
      },
      { prefix, connection, concurrency: 4 },
    );
    this.worker = worker;
    queue.on('error', () => this.logger.warn('Webhook queue connection error'));
    worker.on('error', () => this.logger.warn('Webhook worker connection error'));
    void Promise.all([queue.waitUntilReady(), worker.waitUntilReady()])
      .then(() => {
        if (this.queue !== queue) return;
        this.timer = setInterval(() => this.poll(), 1000);
        this.poll();
      })
      .catch(async () => {
        if (this.queue !== queue) return;
        this.logger.warn('Webhook queue initialization will retry');
        await Promise.allSettled([worker.close(true), queue.close()]);
        if (this.queue === queue) this.timer = setTimeout(() => this.connect(), 1000);
      });
  }

  async beforeApplicationShutdown(): Promise<void> {
    clearTimeout(this.timer);
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
      .catch(() => this.logger.warn('Webhook dispatch will retry'))
      .finally(() => {
        delete this.dispatching;
      });
  }

  private async dispatch(queue: Queue<WebhookDispatch>): Promise<void> {
    if ((await queue.client).status !== 'ready') return;
    const deliveries = await this.webhooks.dueDeliveries();
    if (deliveries.length === 0) return;
    await queue.addBulk(
      deliveries.map((delivery) => ({
        name: 'deliver',
        data: delivery,
        opts: { jobId: delivery.id + '-' + delivery.attempts },
      })),
    );
  }
}
