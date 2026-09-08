import { Inject, Injectable } from '@nestjs/common';
import { EntityType, type RecordIngestionResult, type RecordInputDto } from '@resolve/contracts';
import { DatabaseEntityType, Prisma, type ResolvePrismaClient } from '@resolve/database';
import { NORMALIZATION_VERSION, normalizeRecord } from '@resolve/normalization';

import { acquireTransactionLock } from '../common/database/advisory-lock.js';
import { ApiException } from '../common/http/api-exception.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { hashCanonicalJson } from './canonical-json.js';
import type { RecordIngestionExecution } from './record-response.dto.js';

const OPERATION = 'POST /v1/records';

@Injectable()
export class RecordIngestionService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient) {}

  ingest(
    tenantId: string,
    input: RecordInputDto,
    rawData: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<RecordIngestionExecution> {
    const requestHash = hashCanonicalJson({
      source: input.source,
      external_id: input.external_id,
      entity_type: input.entity_type,
      data: rawData,
    });
    const payloadHash = hashCanonicalJson(rawData);

    return this.prisma.$transaction(async (transaction) => {
      if (idempotencyKey) {
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
          return {
            body: replay.responseBody as unknown as RecordIngestionResult,
            httpStatus: replay.responseStatus,
            replayed: true,
          };
        }
      }

      const source = await transaction.sourceSystem.findUnique({
        where: { tenantId_name: { tenantId, name: input.source } },
      });
      if (!source) throw new ApiException(404, 'SOURCE_NOT_FOUND', 'Source does not exist');
      await acquireTransactionLock(
        transaction,
        `record:${tenantId}:${source.id}:${input.external_id}`,
      );
      const execution = await upsertRecord(
        transaction,
        tenantId,
        source.id,
        input,
        rawData,
        payloadHash,
      );

      if (idempotencyKey) {
        await transaction.idempotencyRequest.create({
          data: {
            tenantId,
            key: idempotencyKey,
            operation: OPERATION,
            requestHash,
            responseStatus: execution.httpStatus,
            responseBody: execution.body as unknown as Prisma.InputJsonObject,
          },
        });
      }
      return execution;
    });
  }
}

async function upsertRecord(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  sourceSystemId: string,
  input: RecordInputDto,
  rawData: Record<string, unknown>,
  payloadHash: string,
): Promise<RecordIngestionExecution> {
  const databaseEntityType =
    input.entity_type === EntityType.Person
      ? DatabaseEntityType.PERSON
      : DatabaseEntityType.COMPANY;
  const normalized = normalizeRecord(input.entity_type, rawData);
  const normalizedData = {
    normalizedPayload: normalized.normalized_payload as Prisma.InputJsonObject,
    normalizationVersion: normalized.normalization_version,
    normalizedEmail: normalized.normalized_email,
    normalizedPhone: normalized.normalized_phone,
    companyDomain: normalized.company_domain,
    normalizedNamePrefix: normalized.normalized_name_prefix,
  };
  let existing = await transaction.sourceRecord.findUnique({
    where: {
      tenantId_sourceSystemId_externalId: {
        tenantId,
        sourceSystemId,
        externalId: input.external_id,
      },
    },
  });

  if (!existing) {
    const created = await transaction.sourceRecord.create({
      data: {
        tenantId,
        sourceSystemId,
        externalId: input.external_id,
        entityType: databaseEntityType,
        rawPayload: rawData as Prisma.InputJsonObject,
        rawPayloadHash: payloadHash,
        ...normalizedData,
      },
    });
    await transaction.sourceRecordVersion.create({
      data: {
        tenantId,
        sourceRecordId: created.id,
        version: 1,
        rawPayload: rawData as Prisma.InputJsonObject,
        payloadHash,
      },
    });
    return executionFor(created, input.entity_type, 'CREATED', 201);
  }

  if (existing.entityType !== databaseEntityType) {
    throw new ApiException(
      409,
      'ENTITY_TYPE_CONFLICT',
      'Entity type cannot change for a source record',
    );
  }

  if (!existing.rawPayloadHash) {
    const legacyHash = hashCanonicalJson(existing.rawPayload);
    await transaction.sourceRecordVersion.create({
      data: {
        tenantId,
        sourceRecordId: existing.id,
        version: existing.currentVersion,
        rawPayload: existing.rawPayload as Prisma.InputJsonValue,
        payloadHash: legacyHash,
      },
    });
    existing = await transaction.sourceRecord.update({
      where: { id: existing.id },
      data: { rawPayloadHash: legacyHash },
    });
  }

  if (existing.rawPayloadHash === payloadHash) {
    if (existing.normalizationVersion !== NORMALIZATION_VERSION) {
      existing = await transaction.sourceRecord.update({
        where: { id: existing.id },
        data: normalizedData,
      });
    }
    return executionFor(existing, input.entity_type, 'UNCHANGED', 200);
  }

  const nextVersion = existing.currentVersion + 1;
  await transaction.sourceRecordVersion.create({
    data: {
      tenantId,
      sourceRecordId: existing.id,
      version: nextVersion,
      rawPayload: rawData as Prisma.InputJsonObject,
      payloadHash,
    },
  });
  const updated = await transaction.sourceRecord.update({
    where: { id: existing.id },
    data: {
      currentVersion: nextVersion,
      rawPayload: rawData as Prisma.InputJsonObject,
      rawPayloadHash: payloadHash,
      ...normalizedData,
    },
  });
  return executionFor(updated, input.entity_type, 'UPDATED', 200);
}

function executionFor(
  record: {
    id: string;
    sourceSystemId: string;
    externalId: string;
    currentVersion: number;
    createdAt: Date;
    updatedAt: Date;
  },
  entityType: EntityType,
  operation: 'CREATED' | 'UPDATED' | 'UNCHANGED',
  httpStatus: number,
): RecordIngestionExecution {
  return {
    body: {
      record_id: record.id,
      source_id: record.sourceSystemId,
      external_id: record.externalId,
      entity_type: entityType,
      version: record.currentVersion,
      status: 'STORED',
      operation,
      created_at: record.createdAt.toISOString(),
      updated_at: record.updatedAt.toISOString(),
    },
    httpStatus,
    replayed: false,
  };
}
