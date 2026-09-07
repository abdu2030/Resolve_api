# Day 3 Foundational Schema Design

## Goal

Add the first PostgreSQL schema for tenant-owned API credentials, source data, canonical entities, and record-to-entity links. Commit a Prisma migration and prove its constraints and indexes against PostgreSQL.

## Scope

Day 3 adds `tenants`, `api_keys`, `source_systems`, `source_records`, `entities`, and `entity_record_links`. It also adds tenant-safe foreign keys, migration commands, blocking indexes, integration tests, and CI migration coverage.

Authentication, source registration, ingestion, normalization logic, candidate queries, matching, review cases, and merge or split behavior remain out of scope.

## Design Choice

Use typed columns for identifiers, ownership, lifecycle data, and blocking keys. Use PostgreSQL `jsonb` for raw, normalized, canonical, and plan-specific data. This provides ordinary B-tree indexes for known blocking queries without creating a generic attribute system.

## Database Conventions

- Prisma models use PascalCase and fields use camelCase.
- PostgreSQL tables and columns use snake_case through Prisma mappings.
- Primary keys use PostgreSQL UUID columns with database `gen_random_uuid()` defaults.
- Timestamps use `timestamptz(3)`.
- Mutable rows contain `created_at` and `updated_at`.
- Tenant-owned rows contain a required `tenant_id`.
- Foreign keys use restrictive deletion behavior to protect source truth.
- References between tenant-owned rows include `tenant_id` in composite foreign keys.
- Constraints and indexes use explicit names.

## Enums

- `TenantStatus`: `ACTIVE`, `SUSPENDED`, `DISABLED`; default `ACTIVE`.
- `EntityType`: `PERSON`, `COMPANY`.
- `MatchDecision`: `AUTO_MATCH`, `REVIEW`, `NO_MATCH`.

The API can map `EntityType` to its lowercase JSON representation. Day 3 stores decisions but does not calculate them.

## Tables

### tenants

| Column          | Type and rules                           |
| --------------- | ---------------------------------------- |
| `id`            | UUID primary key with UUID default       |
| `name`          | varchar(120), required                   |
| `status`        | TenantStatus, required, default `ACTIVE` |
| `plan`          | varchar(50), required, default `free`    |
| `plan_metadata` | jsonb, required, default `{}`            |
| `created_at`    | timestamptz(3), current-time default     |
| `updated_at`    | timestamptz(3), maintained by Prisma     |

### api_keys

| Column         | Type and rules                             |
| -------------- | ------------------------------------------ |
| `id`           | UUID primary key with UUID default         |
| `tenant_id`    | UUID foreign key to `tenants`              |
| `name`         | varchar(120), required operator label      |
| `prefix`       | varchar(32), required identifiable prefix  |
| `key_hash`     | varchar(255), required and globally unique |
| `scopes`       | text array, required, default empty array  |
| `created_at`   | timestamptz(3), current-time default       |
| `revoked_at`   | nullable timestamptz(3)                    |
| `last_used_at` | nullable timestamptz(3)                    |

Indexes support tenant key listing and prefix lookup. The schema has no plaintext-key column.

### source_systems

| Column       | Type and rules                       |
| ------------ | ------------------------------------ |
| `id`         | UUID primary key with UUID default   |
| `tenant_id`  | UUID foreign key to `tenants`        |
| `name`       | varchar(120), required               |
| `type`       | varchar(50), required                |
| `created_at` | timestamptz(3), current-time default |
| `updated_at` | timestamptz(3), maintained by Prisma |

The constraint `source_systems_tenant_name_key` makes `(tenant_id, name)` unique. Different tenants may use the same source name.

### source_records

| Column                   | Type and rules                                   |
| ------------------------ | ------------------------------------------------ |
| `id`                     | UUID primary key with UUID default               |
| `tenant_id`              | UUID foreign key to `tenants`                    |
| `source_system_id`       | UUID tenant-safe foreign key to `source_systems` |
| `external_id`            | varchar(255), required                           |
| `entity_type`            | EntityType, required                             |
| `raw_payload`            | jsonb, required source truth                     |
| `normalized_payload`     | nullable jsonb                                   |
| `normalization_version`  | nullable varchar(50)                             |
| `normalized_email`       | nullable varchar(320)                            |
| `normalized_phone`       | nullable varchar(32)                             |
| `company_domain`         | nullable varchar(253)                            |
| `normalized_name_prefix` | nullable varchar(64)                             |
| `created_at`             | timestamptz(3), current-time default             |
| `updated_at`             | timestamptz(3), maintained by Prisma             |

The constraint `source_records_tenant_source_external_key` enforces uniqueness on `(tenant_id, source_system_id, external_id)`.

The first blocking indexes are:

- `source_records_tenant_normalized_email_idx` on `(tenant_id, normalized_email)`
- `source_records_tenant_normalized_phone_idx` on `(tenant_id, normalized_phone)`
- `source_records_tenant_company_domain_idx` on `(tenant_id, company_domain)`
- `source_records_tenant_type_name_prefix_idx` on `(tenant_id, entity_type, normalized_name_prefix)`

Day 6 will inspect query plans before adding partial, expression, or JSONB indexes.

### entities

| Column           | Type and rules                       |
| ---------------- | ------------------------------------ |
| `id`             | UUID primary key with UUID default   |
| `tenant_id`      | UUID foreign key to `tenants`        |
| `entity_type`    | EntityType, required                 |
| `canonical_data` | jsonb, required, default `{}`        |
| `created_at`     | timestamptz(3), current-time default |
| `updated_at`     | timestamptz(3), maintained by Prisma |

The index `entities_tenant_entity_type_idx` covers `(tenant_id, entity_type)`. Canonical data remains separate from source records.

### entity_record_links

| Column              | Type and rules                                   |
| ------------------- | ------------------------------------------------ |
| `id`                | UUID primary key with UUID default               |
| `tenant_id`         | UUID foreign key to `tenants`                    |
| `entity_id`         | UUID tenant-safe foreign key to `entities`       |
| `source_record_id`  | UUID tenant-safe foreign key to `source_records` |
| `score`             | decimal(5,4), required                           |
| `decision`          | MatchDecision, required                          |
| `algorithm_version` | varchar(50), required                            |
| `created_at`        | timestamptz(3), current-time default             |
| `updated_at`        | timestamptz(3), maintained by Prisma             |

The constraint `entity_record_links_tenant_record_key` makes `(tenant_id, source_record_id)` unique. Merge and split workflows will reassign the current link and store history in a later table.

The index `entity_record_links_tenant_entity_idx` covers `(tenant_id, entity_id)`. The migration adds `entity_record_links_score_range`, which requires `score >= 0 AND score <= 1`.

## Tenant Integrity

Composite foreign keys enforce these rules:

- A source record references a source system from its tenant.
- A link references an entity and source record from its tenant.
- Tenant-owned rows do not disappear through accidental cascades.

Composite unique keys on `(tenant_id, id)` provide reference targets. Application queries must still filter by authenticated tenant context.

## Migration and Tests

Create one Prisma migration named `foundational_schema`. Generate it from the Day 2 schema, inspect the SQL, and add the score check because Prisma does not express check constraints in its schema language.

A separate `npm run test:integration` command will use an isolated PostgreSQL schema. The test will:

1. Apply all migrations to empty state, then deploy again to prove idempotency.
2. Confirm all six tables, three enums, named constraints, and blocking indexes.
3. Prove same-tenant source-record duplicates fail.
4. Prove different tenants may reuse source names and external IDs.
5. Prove cross-tenant source-record and link references fail.
6. Prove link scores outside 0 through 1 fail.
7. Drop the test schema during cleanup.

The standard unit suite remains independent of PostgreSQL. GitHub Actions will provide PostgreSQL and run both suites.

## Repository Changes

- Expand `packages/database/prisma/schema.prisma`.
- Add `packages/database/prisma/migrations/<timestamp>_foundational_schema/migration.sql`.
- Add a database integration test and Jest integration configuration.
- Add migration and integration-test scripts.
- Add PostgreSQL migration coverage to GitHub Actions.
- Update the README and architecture note.

## Acceptance Criteria

- Prisma validates and generates its client.
- A clean PostgreSQL database accepts the committed migration twice without error.
- PostgreSQL enforces record uniqueness, tenant-safe references, and the score range.
- PostgreSQL exposes the named blocking indexes.
- Unit tests, integration tests, linting, type-checking, formatting, builds, and Compose validation pass.
- The API and worker start against the migrated database.
