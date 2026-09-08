import { Prisma, type DatabaseEntityType } from '@resolve/database';

import type { BlockingSignal } from './blocking.types.js';

export const BLOCKING_QUERY_INDEXES: Readonly<Record<BlockingSignal, string>> = {
  EXACT_EMAIL: 'source_records_tenant_normalized_email_idx',
  EXACT_PHONE: 'source_records_tenant_normalized_phone_idx',
  COMPANY_DOMAIN: 'source_records_tenant_company_domain_idx',
  NAME_LOCATION: 'source_records_tenant_type_name_prefix_idx',
};

interface QueryInput {
  schema: string;
  tenantId: string;
  sourceRecordId: string;
  entityType: DatabaseEntityType;
  limit: number;
}

interface ExactQueryInput extends QueryInput {
  value: string;
}

interface NameLocationQueryInput extends QueryInput {
  namePrefix: string;
  city: string;
  country: string;
}

export function exactEmailQuery(input: ExactQueryInput): Prisma.Sql {
  return candidateQuery(input, Prisma.sql`supporting.normalized_email = ${input.value}`);
}

export function exactPhoneQuery(input: ExactQueryInput): Prisma.Sql {
  return candidateQuery(input, Prisma.sql`supporting.normalized_phone = ${input.value}`);
}

export function companyDomainQuery(input: ExactQueryInput): Prisma.Sql {
  return candidateQuery(input, Prisma.sql`supporting.company_domain = ${input.value}`);
}

export function nameLocationQuery(input: NameLocationQueryInput): Prisma.Sql {
  return candidateQuery(
    input,
    Prisma.sql`
      supporting.normalized_name_prefix = ${input.namePrefix}
      AND supporting.normalized_payload #>> '{address,city}' = ${input.city}
      AND supporting.normalized_payload #>> '{address,country}' = ${input.country}
    `,
  );
}

function candidateQuery(input: QueryInput, signalPredicate: Prisma.Sql): Prisma.Sql {
  const sourceRecords = qualifiedName(input.schema, 'source_records');
  const entityRecordLinks = qualifiedName(input.schema, 'entity_record_links');
  const entities = qualifiedName(input.schema, 'entities');
  const entityType = qualifiedName(input.schema, 'entity_type');

  return Prisma.sql`
    SELECT DISTINCT ON (link.entity_id)
      link.entity_id AS "entityId",
      entity.entity_type AS "entityType",
      supporting.id AS "supportingRecordId"
    FROM ${sourceRecords} AS supporting
    JOIN ${entityRecordLinks} AS link
      ON link.tenant_id = supporting.tenant_id
      AND link.source_record_id = supporting.id
    JOIN ${entities} AS entity
      ON entity.tenant_id = link.tenant_id
      AND entity.id = link.entity_id
    WHERE supporting.tenant_id = CAST(${input.tenantId} AS UUID)
      AND supporting.entity_type = CAST(${input.entityType} AS ${entityType})
      AND entity.entity_type = supporting.entity_type
      AND supporting.id <> CAST(${input.sourceRecordId} AS UUID)
      AND ${signalPredicate}
    ORDER BY link.entity_id ASC, supporting.id ASC
    LIMIT ${input.limit}
  `;
}

function qualifiedName(schema: string, name: string): Prisma.Sql {
  return Prisma.raw(quoteIdentifier(schema) + '.' + quoteIdentifier(name));
}

function quoteIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}
