import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentConfig } from '@resolve/config';
import { Prisma, type ResolvePrismaClient } from '@resolve/database';

import { ApiException, type ApiErrorBody } from '../common/http/api-exception.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { RecordIngestionService } from '../records/record-ingestion.service.js';
import { publishWebhookEvent } from '../webhooks/webhook-events.js';
import type { StoredBatchRecord } from './batch-job.service.js';

export const BATCH_MAX_ATTEMPTS = 3;
const NONTERMINAL = ['QUEUED', 'RUNNING', 'RETRYING'] as const;
const DISPATCH_SCAN_SIZE = 25;
const DISPATCH_INTERVAL_MS = 5_000;

export interface BatchIdentity {
  tenantId: string;
  id: string;
}

interface BatchAttempt extends BatchIdentity {
  number: number;
}

@Injectable()
export class BatchExecutionService {
  private readonly jobsTable: Prisma.Sql;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient,
    private readonly ingestion: RecordIngestionService,
    config: ConfigService<EnvironmentConfig, true>,
  ) {
    const schema =
      new URL(config.get('databaseUrl', { infer: true })).searchParams.get('schema') ?? 'public';
    this.jobsTable = Prisma.raw('"' + schema.replaceAll('"', '""') + '"."jobs"');
  }

  async dueJobs(): Promise<BatchIdentity[]> {
    // Dispatch spans tenants. Claim a bounded set and return identifiers only.
    return this.prisma.$queryRaw<BatchIdentity[]>`
      WITH due AS (
        SELECT id
        FROM ${this.jobsTable}
        WHERE status IN ('QUEUED', 'RUNNING', 'RETRYING')
          AND dispatch_after <= CURRENT_TIMESTAMP
        ORDER BY dispatch_after, id
        LIMIT ${DISPATCH_SCAN_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${this.jobsTable} AS jobs SET dispatch_after = CURRENT_TIMESTAMP + ${DISPATCH_INTERVAL_MS}::int * INTERVAL '1 millisecond'
      FROM due WHERE jobs.id = due.id
      RETURNING jobs.tenant_id AS "tenantId", jobs.id
    `;
  }

  async markDeliveryFailed(identity: BatchIdentity): Promise<void> {
    await this.prisma.$transaction((transaction) =>
      failBatch(transaction, identity, 'BATCH_DELIVERY_FAILED'),
    );
  }

  async process(identity: BatchIdentity): Promise<void> {
    const attempt = await this.start(identity);
    if (!attempt) return;
    try {
      while (await this.processNext(attempt)) {
        // Each item commits before the next item starts.
      }
    } catch {
      const last = attempt.number >= BATCH_MAX_ATTEMPTS;
      if (last) {
        await this.prisma.$transaction((transaction) =>
          failBatch(transaction, attempt, 'BATCH_RETRIES_EXHAUSTED', attempt.number),
        );
      } else {
        await this.prisma.job.updateMany({
          where: {
            tenantId: attempt.tenantId,
            id: attempt.id,
            status: 'RUNNING',
            attempts: attempt.number,
          },
          data: { status: 'RETRYING' },
        });
      }
      // Redis and logs must not receive database errors containing record data.
      throw new Error(last ? 'Batch attempts exhausted' : 'Batch processing will retry');
    }
  }

  private start(identity: BatchIdentity): Promise<BatchAttempt | undefined> {
    return this.prisma.$transaction(async (transaction) => {
      const job = await lockJob(transaction, this.jobsTable, identity);
      if (!job || job.status === 'FAILED' || job.status === 'SUCCEEDED') return;
      const where = tenantJobKey(identity);
      if (job.attempts >= BATCH_MAX_ATTEMPTS) {
        await failBatch(transaction, identity, 'BATCH_RETRIES_EXHAUSTED');
        return;
      }
      const number = job.attempts + 1;
      await transaction.job.update({ where, data: { status: 'RUNNING', attempts: number } });
      return { ...identity, number };
    });
  }

  private async processNext(attempt: BatchAttempt): Promise<boolean> {
    try {
      return await this.advance(attempt);
    } catch (error) {
      if (!(error instanceof RecordRejected)) throw error;
      return this.advance(attempt, error);
    }
  }

  private advance(attempt: BatchAttempt, rejected?: RecordRejected): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const job = await lockJob(transaction, this.jobsTable, attempt);
      if (!job || job.status !== 'RUNNING' || job.attempts !== attempt.number) return false;
      const where = tenantJobKey(attempt);
      const tenant = await transaction.tenant.findUniqueOrThrow({
        where: { id: attempt.tenantId },
        select: { status: true },
      });
      if (tenant.status !== 'ACTIVE') {
        await failBatch(transaction, attempt, 'TENANT_INACTIVE', attempt.number);
        return false;
      }

      const position = job.processedRecords;
      if (rejected && rejected.position !== position) return false;
      const itemKey = {
        tenantId_jobId_position: { tenantId: attempt.tenantId, jobId: attempt.id, position },
      };
      const item = await transaction.jobRecord.findUniqueOrThrow({
        where: itemKey,
        select: { input: true },
      });
      const record = item.input as unknown as StoredBatchRecord;
      let result: Prisma.InputJsonObject | undefined;
      if (!rejected) {
        try {
          const ingested = await this.ingestion.ingestInTransaction(
            transaction,
            attempt.tenantId,
            record,
            record.data,
          );
          result = ingested.body as unknown as Prisma.InputJsonObject;
        } catch (error) {
          if (error instanceof ApiException && [404, 409, 422].includes(error.getStatus())) {
            throw new RecordRejected(position, (error.getResponse() as ApiErrorBody).error.code);
          }
          throw error;
        }
      }
      await transaction.jobRecord.update({
        where: itemKey,
        data: rejected ? { errorCode: rejected.code } : { result: result! },
      });
      const processed = position + 1;
      const failed = job.failedRecords + (rejected ? 1 : 0);
      const finished = processed === job.totalRecords;
      await transaction.job.update({
        where,
        data: {
          processedRecords: processed,
          failedRecords: failed,
          ...(finished
            ? {
                status: failed > 0 ? 'FAILED' : 'SUCCEEDED',
                errorCode: failed > 0 ? 'BATCH_RECORDS_FAILED' : null,
                finishedAt: new Date(),
              }
            : {}),
        },
      });
      if (finished) {
        await publishWebhookEvent(transaction, attempt.tenantId, 'job.completed', {
          job_id: attempt.id,
          status: failed > 0 ? 'FAILED' : 'SUCCEEDED',
        });
      }
      return !finished;
    });
  }
}

async function failBatch(
  transaction: Prisma.TransactionClient,
  { id, tenantId }: BatchIdentity,
  errorCode: string,
  attempt?: number,
): Promise<void> {
  const failed = await transaction.job.updateMany({
    where: {
      id,
      tenantId,
      ...(attempt === undefined
        ? { status: { in: [...NONTERMINAL] } }
        : { status: 'RUNNING', attempts: attempt }),
    },
    data: { status: 'FAILED', errorCode, finishedAt: new Date() },
  });
  if (failed.count) {
    await publishWebhookEvent(transaction, tenantId, 'job.completed', {
      job_id: id,
      status: 'FAILED',
    });
  }
}

class RecordRejected extends Error {
  constructor(
    readonly position: number,
    readonly code: string,
  ) {
    super('Batch record rejected');
  }
}

function tenantJobKey({ tenantId, id }: BatchIdentity): { tenantId_id: BatchIdentity } {
  return { tenantId_id: { tenantId, id } };
}

async function lockJob(
  transaction: Prisma.TransactionClient,
  jobsTable: Prisma.Sql,
  identity: BatchIdentity,
): Promise<
  | {
      status: string;
      attempts: number;
      processedRecords: number;
      failedRecords: number;
      totalRecords: number;
    }
  | undefined
> {
  // An attempt number fences a previous worker if BullMQ loses its active lock.
  const [job] = await transaction.$queryRaw<
    {
      status: string;
      attempts: number;
      processedRecords: number;
      failedRecords: number;
      totalRecords: number;
    }[]
  >`
    SELECT status, attempts, processed_records AS "processedRecords",
           failed_records AS "failedRecords", total_records AS "totalRecords"
    FROM ${jobsTable} WHERE tenant_id = ${identity.tenantId}::uuid AND id = ${identity.id}::uuid
    FOR UPDATE
  `;
  return job;
}
