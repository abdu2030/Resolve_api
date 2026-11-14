import { Inject, Injectable } from '@nestjs/common';
import type { RecordIngestionResult, RecordInputDto } from '@resolve/contracts';
import { Prisma, type ResolvePrismaClient } from '@resolve/database';

import { acquireTransactionLock } from '../common/database/advisory-lock.js';
import { ApiException } from '../common/http/api-exception.js';
import { hashCanonicalJson } from '../common/json/canonical-json.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import type { AcceptedBatchDto, BatchJobDto } from './batch-job.dto.js';

const OPERATION = 'POST /v1/records/batch';

export interface StoredBatchRecord {
  source: RecordInputDto['source'];
  external_id: RecordInputDto['external_id'];
  entity_type: RecordInputDto['entity_type'];
  data: Record<string, unknown>;
}

@Injectable()
export class BatchJobService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient) {}

  submit(
    tenantId: string,
    records: StoredBatchRecord[],
    idempotencyKey: string,
  ): Promise<{ body: AcceptedBatchDto; replayed: boolean }> {
    const requestHash = hashCanonicalJson({ records });
    return this.prisma.$transaction(async (transaction) => {
      await acquireTransactionLock(transaction, `idempotency:${tenantId}:${idempotencyKey}`);
      const replay = await transaction.idempotencyRequest.findUnique({
        where: { tenantId_key: { tenantId, key: idempotencyKey } },
      });
      if (replay) {
        if (replay.operation !== OPERATION || replay.requestHash !== requestHash) {
          throw new ApiException(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used for a different request',
          );
        }
        return { body: replay.responseBody as unknown as AcceptedBatchDto, replayed: true };
      }

      const sources = [...new Set(records.map((record) => record.source))];
      const count = await transaction.sourceSystem.count({
        where: { tenantId, name: { in: sources } },
      });
      if (count !== sources.length) {
        throw new ApiException(404, 'SOURCE_NOT_FOUND', 'A batch source does not exist');
      }

      const job = await transaction.job.create({
        data: {
          tenantId,
          totalRecords: records.length,
          records: {
            createMany: {
              data: records.map((record, position) => ({
                position,
                input: record as unknown as Prisma.InputJsonObject,
              })),
            },
          },
        },
        select: { id: true },
      });
      const body: AcceptedBatchDto = { job_id: job.id, status: 'QUEUED' };
      await transaction.idempotencyRequest.create({
        data: {
          tenantId,
          key: idempotencyKey,
          operation: OPERATION,
          requestHash,
          responseStatus: 202,
          responseBody: { ...body },
        },
      });
      return { body, replayed: false };
    });
  }

  async get(tenantId: string, id: string): Promise<BatchJobDto> {
    // The counters and result rows must come from the same database snapshot.
    return this.prisma.$transaction(
      async (transaction) => {
        const job = await transaction.job.findUnique({
          where: { tenantId_id: { tenantId, id } },
          include: {
            records: {
              where: { OR: [{ result: { not: Prisma.DbNull } }, { errorCode: { not: null } }] },
              orderBy: { position: 'asc' },
              select: { position: true, result: true, errorCode: true },
            },
          },
        });
        if (!job) throw new ApiException(404, 'JOB_NOT_FOUND', 'Job does not exist');
        return {
          job_id: job.id,
          status: job.status,
          total_records: job.totalRecords,
          processed_records: job.processedRecords,
          succeeded_records: job.processedRecords - job.failedRecords,
          failed_records: job.failedRecords,
          attempts: job.attempts,
          error: job.errorCode ? { code: job.errorCode } : null,
          created_at: job.createdAt.toISOString(),
          finished_at: job.finishedAt?.toISOString() ?? null,
          results: job.records.map((record) => ({
            index: record.position,
            result: record.result as unknown as RecordIngestionResult | null,
            error: record.errorCode ? { code: record.errorCode } : null,
          })),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
