import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentConfig } from '@resolve/config';
import type { Prisma, ResolvePrismaClient } from '@resolve/database';

import { PRISMA_CLIENT } from '../infrastructure/infrastructure.tokens.js';
import { BLOCKING_VERSION } from './blocking-policy.js';
import {
  companyDomainQuery,
  exactEmailQuery,
  exactPhoneQuery,
  nameLocationQuery,
} from './blocking.queries.js';
import type { BlockingPassRows, BlockingQueryRow, BlockingResult } from './blocking.types.js';
import { CandidateSourceRecordNotFoundError } from './candidate-source-record-not-found.error.js';
import { collectCandidates } from './candidate-collector.js';

interface BlockingLocation {
  city: string;
  country: string;
}

type CandidateQueryClient = Pick<Prisma.TransactionClient, 'sourceRecord' | '$queryRaw'>;

@Injectable()
export class CandidateGenerationService {
  private readonly maximum: number;
  private readonly schema: string;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ResolvePrismaClient,
    config: ConfigService<EnvironmentConfig, true>,
  ) {
    this.maximum = config.get('blockingMaxCandidates', { infer: true });
    this.schema = databaseSchema(config.get('databaseUrl', { infer: true }));
  }

  async findCandidates(
    tenantId: string,
    sourceRecordId: string,
    client: CandidateQueryClient = this.prisma,
  ): Promise<BlockingResult> {
    const sourceRecord = await client.sourceRecord.findUnique({
      where: { tenantId_id: { tenantId, id: sourceRecordId } },
      select: {
        id: true,
        entityType: true,
        normalizedEmail: true,
        normalizedPhone: true,
        companyDomain: true,
        normalizedNamePrefix: true,
        normalizedPayload: true,
      },
    });
    if (!sourceRecord) throw new CandidateSourceRecordNotFoundError();

    const common = {
      schema: this.schema,
      tenantId,
      sourceRecordId: sourceRecord.id,
      entityType: sourceRecord.entityType,
      limit: this.maximum + 1,
    };
    const queries: Array<{
      signal: BlockingPassRows['signal'];
      query: Prisma.Sql;
    }> = [];

    if (sourceRecord.normalizedEmail) {
      queries.push({
        signal: 'EXACT_EMAIL',
        query: exactEmailQuery({ ...common, value: sourceRecord.normalizedEmail }),
      });
    }
    if (sourceRecord.normalizedPhone) {
      queries.push({
        signal: 'EXACT_PHONE',
        query: exactPhoneQuery({ ...common, value: sourceRecord.normalizedPhone }),
      });
    }
    if (sourceRecord.companyDomain) {
      queries.push({
        signal: 'COMPANY_DOMAIN',
        query: companyDomainQuery({ ...common, value: sourceRecord.companyDomain }),
      });
    }

    const location = blockingLocation(sourceRecord.normalizedPayload);
    if (sourceRecord.normalizedNamePrefix && location) {
      queries.push({
        signal: 'NAME_LOCATION',
        query: nameLocationQuery({
          ...common,
          namePrefix: sourceRecord.normalizedNamePrefix,
          city: location.city,
          country: location.country,
        }),
      });
    }

    const passes = await Promise.all(
      queries.map(async ({ signal, query }): Promise<BlockingPassRows> => ({
        signal,
        rows: await client.$queryRaw<BlockingQueryRow[]>(query),
      })),
    );
    const collected = collectCandidates(passes, this.maximum);

    return {
      blockingVersion: BLOCKING_VERSION,
      ...collected,
    };
  }
}

function blockingLocation(value: Prisma.JsonValue | null): BlockingLocation | null {
  const payload = plainObject(value);
  const address = plainObject(payload?.address);
  const city = nonEmptyString(address?.city);
  const country = nonEmptyString(address?.country);
  return city && country ? { city, country } : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function databaseSchema(databaseUrl: string): string {
  const configured = new URL(databaseUrl).searchParams.get('schema');
  return configured && configured.length > 0 ? configured : 'public';
}
