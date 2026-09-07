import { Inject, Injectable } from '@nestjs/common';
import type { CreateSourceDto } from '@resolve/contracts';
import type { ResolvePrismaClient } from '@resolve/database';

import { acquireTransactionLock } from '../common/database/advisory-lock.js';
import { ApiException } from '../common/http/api-exception.js';
import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import type { SourceRegistrationResult, SourceResponseDto } from './source-response.dto.js';

@Injectable()
export class SourceRegistrationService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient) {}

  register(tenantId: string, input: CreateSourceDto): Promise<SourceRegistrationResult> {
    return this.prisma.$transaction(async (transaction) => {
      await acquireTransactionLock(transaction, `source:${tenantId}:${input.name}`);
      const existing = await transaction.sourceSystem.findUnique({
        where: { tenantId_name: { tenantId, name: input.name } },
      });
      if (existing) {
        if (existing.type !== input.type) {
          throw new ApiException(
            409,
            'SOURCE_TYPE_CONFLICT',
            'A source with this name already exists with a different type',
          );
        }
        return { body: mapSource(existing), created: false };
      }
      const created = await transaction.sourceSystem.create({
        data: { tenantId, name: input.name, type: input.type },
      });
      return { body: mapSource(created), created: true };
    });
  }
}

function mapSource(source: {
  id: string;
  name: string;
  type: string;
  createdAt: Date;
}): SourceResponseDto {
  return {
    source_id: source.id,
    name: source.name,
    type: source.type,
    created_at: source.createdAt.toISOString(),
  };
}
