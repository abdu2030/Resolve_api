# Week 2 Day 4: Canonicalization, Survivorship, and Entity Read APIs

**Status:** Implemented, verified, and approved

## Goal

Add deterministic canonicalization after entity resolution so every linked Person or Company has a consolidated representation with field-level provenance and immutable history. Expose tenant-scoped APIs for the entity, its linked records, and its canonical history.

Raw source records remain immutable source truth. Canonical data is derived state and never replaces them.

## Scope

- Source-system priority used by survivorship.
- Versioned field selection based on source priority, completeness, recency, and a stable tie-break.
- Current field-level provenance and append-only canonical snapshots.
- Canonical recomputation when a record is newly linked or a linked record changes.
- `GET /v1/entities/:entityId`.
- `GET /v1/entities/:entityId/records`.
- `GET /v1/entities/:entityId/history`.
- The `entities:read` API-key scope.
- Unit, integration, authorization, contract, and migration coverage.

## Out of Scope

- Merge and split operations.
- Review-case decisions.
- Manual field locks or overrides.
- A source-priority update endpoint.
- Tenant-specific or field-specific survivorship policies.
- Background canonical recomputation.
- A separate canonicalization service or worker deployment.

## Versioning

The initial policy version is `canonicalization-v1`. Every snapshot and current provenance row stores it. Existing normalization, blocking, comparison, scoring, and decision versions do not change.

A behavioral change to field extraction, completeness, ranking, or canonical formatting requires a new canonicalization version with tests and documentation.

## Source Priority Contract

`POST /v1/sources` accepts optional integer `priority`:

```json
{
  "name": "Verified CRM",
  "type": "CRM",
  "priority": 10
}
```

- Lower values have higher authority.
- Valid range: `0..1000`.
- Default: `100`.
- The response includes the effective priority.
- Existing sources receive `100` in the migration.
- Replaying the same source definition returns the existing source.
- Reusing a source name with a different type returns the existing `409 SOURCE_TYPE_CONFLICT`. Reusing it with a different effective priority returns `409 SOURCE_PRIORITY_CONFLICT`. Neither case silently updates source configuration.

No priority-update endpoint is included.

## Canonical Field Model

Canonical data stays in `entities.canonical_data` as JSON. Missing, null, empty, and whitespace-only values do not become candidates.

Person fields:

```json
{
  "name": "Abdulkerim Hassen",
  "email": "abdul@example.com",
  "phone": "+251911223344",
  "company": "Acme Trading PLC",
  "company_domain": "acme.example",
  "address": {
    "line1": "12 Bole Road",
    "city": "Addis Ababa",
    "region": "Addis Ababa",
    "postal_code": "1000",
    "country": "ET"
  }
}
```

Company fields:

```json
{
  "name": "Acme Trading PLC",
  "domain": "acme.example",
  "email": "office@acme.example",
  "phone": "+251111234567",
  "registration_id": "REG-123",
  "address": {
    "line1": "12 Bole Road",
    "city": "Addis Ababa",
    "region": "Addis Ababa",
    "postal_code": "1000",
    "country": "ET"
  }
}
```

Candidate extraction uses the latest stored version of every currently linked source record.

| Entity type    | Field path            | Canonical value                                | Completeness basis                  |
| -------------- | --------------------- | ---------------------------------------------- | ----------------------------------- |
| Person         | `name`                | Trimmed, whitespace-collapsed raw name         | Normalized name length              |
| Person         | `email`               | Normalized email                               | Present = 1                         |
| Person         | `phone`               | Normalized phone                               | Present = 1                         |
| Person         | `company`             | Trimmed, whitespace-collapsed raw company name | Normalized full company-name length |
| Person         | `company_domain`      | Normalized company domain                      | Present = 1                         |
| Person/Company | `address.line1`       | Trimmed, whitespace-collapsed raw line         | Normalized line length              |
| Person/Company | `address.city`        | Trimmed, whitespace-collapsed raw city         | Normalized city length              |
| Person/Company | `address.region`      | Trimmed, whitespace-collapsed raw region       | Normalized region length            |
| Person/Company | `address.postal_code` | Trimmed raw postal code                        | Normalized postal-code length       |
| Person/Company | `address.country`     | Normalized country                             | Present = 1                         |
| Company        | `name`                | Trimmed, whitespace-collapsed raw company name | Normalized full company-name length |
| Company        | `domain`              | Normalized domain                              | Present = 1                         |
| Company        | `email`               | Normalized email                               | Present = 1                         |
| Company        | `phone`               | Normalized phone                               | Present = 1                         |
| Company        | `registration_id`     | Trimmed raw registration ID                    | Trimmed length                      |

Address components are independent fields, so different records may supply different components. Canonicalization does not invent values, join names, infer countries, or apply transformations beyond stored normalization and conservative display cleanup.

## Survivorship Policy

Each candidate carries source record/system IDs, source name, external ID, priority, raw and canonical values, completeness score, observed timestamp, and normalization version.

Candidates are ranked lexicographically:

1. Lower source priority.
2. Higher field-specific completeness.
3. Newer source-record `updated_at`.
4. Lexicographically smaller source-record ID.

The ID tie-break is only for determinism.

The winning provenance records:

- `ONLY_CANDIDATE` when there is one candidate.
- `SOURCE_PRIORITY` when priority separates the winner.
- `COMPLETENESS` when priority ties and completeness separates it.
- `RECENCY` when priority and completeness tie and recency separates it.
- `STABLE_TIE_BREAK` when all earlier criteria tie.

Completeness is deterministic and field-local:

- Exact identifiers (email, phone, domain, country) use `1` when present.
- Text uses Unicode code-point length of its stored normalized comparison value.
- Company names use normalized full company-name length.
- Registration IDs use trimmed code-point length.

Unrelated fields never influence a field winner.

`observed_at` and the recency comparison use the source record's `updated_at`, which is the repository's durable time for the latest accepted source-record version.

## Database Design

`source_systems` adds `priority INTEGER NOT NULL DEFAULT 100` and a database check enforcing `0 <= priority <= 1000`.

`entities` adds `canonical_version INTEGER NOT NULL DEFAULT 0`. Version 0 means no canonical snapshot has been produced.

### Current Field Provenance

Add `entity_field_provenance`:

```text
id                       UUID primary key
tenant_id                UUID not null
entity_id                UUID not null
field_path               TEXT not null
canonical_value          JSONB not null
raw_value                JSONB not null
source_record_id         UUID not null
source_system_id         UUID not null
source_external_id       TEXT not null
source_priority          INTEGER not null
selection_rule           CanonicalSelectionRule not null
completeness_score       INTEGER not null
observed_at              TIMESTAMPTZ not null
normalization_version    TEXT not null
canonicalization_version TEXT not null
created_at               TIMESTAMPTZ not null
updated_at               TIMESTAMPTZ not null
```

Constraints and indexes:

- Unique `(tenant_id, entity_id, field_path)`.
- Tenant-safe composite foreign keys to entity, source record, and source system.
- Index `(tenant_id, entity_id)`.

Rows are replaced transactionally during recomputation and describe current canonical state only.

### Canonical History

Add append-only `entity_canonical_versions`:

```text
id                       UUID primary key
tenant_id                UUID not null
entity_id                UUID not null
version                  INTEGER not null
canonical_data           JSONB not null
provenance               JSONB not null
trigger_source_record_id UUID null
trigger_operation        CanonicalTriggerOperation not null
canonicalization_version TEXT not null
created_at               TIMESTAMPTZ not null
```

Constraints and indexes:

- Unique `(tenant_id, entity_id, version)`.
- Tenant-safe composite foreign key to entity.
- Tenant-safe optional composite foreign key to triggering source record.
- Index `(tenant_id, entity_id, version DESC)`.

`CanonicalSelectionRule` contains `ONLY_CANDIDATE`, `SOURCE_PRIORITY`, `COMPLETENESS`, `RECENCY`, and `STABLE_TIE_BREAK`.

`CanonicalTriggerOperation` contains `ENTITY_CREATED`, `RECORD_LINKED`, `RECORD_UPDATED`, and `LEGACY_BACKFILL`. No update or delete path is exposed for history.

## Transaction and Concurrency

Canonicalization stays inside the existing single-record ingestion transaction:

```text
ingest -> normalize -> block -> compare -> score -> decide
       -> link/create entity -> canonicalize -> persist response
```

Behavior:

- `AUTO_MATCH`: recompute the matched entity after the new link is stored.
- `NO_MATCH`: create and link the entity, then create its initial canonical state.
- `REVIEW`: do not canonicalize because no link was accepted.
- Changed payload for an already linked record: recompute that entity.
- Unchanged replay: skip recomputation when canonical version is already greater than zero.
- Unchanged replay for a linked version-0 entity: perform one `LEGACY_BACKFILL`.
- Replayed unresolved review: do not canonicalize.

Before reading linked records and writing canonical state, acquire a transaction-scoped PostgreSQL advisory lock derived from tenant ID and entity ID. This serializes recomputation for one tenant/entity without blocking unrelated entities.

In the transaction, the canonicalizer:

1. Locks the entity.
2. Loads all linked records, latest versions, and source metadata with tenant filters.
3. Computes canonical values and provenance.
4. Compares both with current canonical data and provenance.
5. If unchanged, writes nothing and creates no history.
6. If changed, increments `canonical_version`, updates `canonical_data`, replaces current provenance, and inserts one snapshot.

The unique entity/version constraint remains a final concurrency guard.

## Authorization and Tenant Isolation

Add `entities:read` to the API-scope contract. All entity endpoints require a valid, non-revoked key with this scope. Tenant identity comes only from that key.

Every query includes `tenant_id`. A missing entity and another tenant's entity both return the same `404`. The endpoints never accept a tenant ID.

## API Contracts

### `GET /v1/entities/:entityId`

Success: `200 OK`.

```json
{
  "entity_id": "uuid",
  "entity_type": "PERSON",
  "canonical_data": {
    "name": "Abdulkerim Hassen",
    "email": "abdul@example.com"
  },
  "canonical_version": 2,
  "canonicalization_version": "canonicalization-v1",
  "provenance": {
    "name": {
      "source_record_id": "uuid",
      "source_system_id": "uuid",
      "source_system_name": "Verified CRM",
      "external_id": "crm-123",
      "source_priority": 10,
      "raw_value": "  Abdulkerim Hassen ",
      "canonical_value": "Abdulkerim Hassen",
      "selection_rule": "SOURCE_PRIORITY",
      "completeness_score": 18,
      "observed_at": "2026-09-09T10:00:00.000Z",
      "normalization_version": "normalization-v1",
      "canonicalization_version": "canonicalization-v1"
    }
  },
  "record_count": 2,
  "created_at": "2026-09-09T09:00:00.000Z",
  "updated_at": "2026-09-09T10:00:00.000Z"
}
```

Nested address provenance mirrors canonical structure under `provenance.address`.

For a version greater than zero, `canonicalization_version` comes from that entity's latest canonical history row. For a legacy version-0 entity, return its stored canonical object, `canonicalization_version: null`, and empty provenance. Reads never backfill.

### `GET /v1/entities/:entityId/records`

Query:

- `limit`: integer `1..100`, default `25`.
- `cursor`: optional opaque cursor returned by the previous page.

Order is link creation time descending, then link ID descending. The cursor encodes both keys. Malformed cursors return `400`.

```json
{
  "items": [
    {
      "record_id": "uuid",
      "entity_type": "PERSON",
      "external_id": "crm-123",
      "source": {
        "source_system_id": "uuid",
        "name": "Verified CRM",
        "type": "CRM",
        "priority": 10
      },
      "raw_payload": {},
      "normalized_payload": {},
      "normalization_version": "normalization-v1",
      "record_created_at": "2026-09-09T09:00:00.000Z",
      "record_updated_at": "2026-09-09T10:00:00.000Z",
      "link": {
        "decision": "AUTO_MATCH",
        "confidence": 0.963,
        "algorithm_version": "rules-0.1.0",
        "explanation": {},
        "linked_at": "2026-09-09T10:00:00.000Z"
      }
    }
  ],
  "next_cursor": null
}
```

`raw_payload` is deliberately returned for authenticated audit use and must not be logged.

### `GET /v1/entities/:entityId/history`

Query:

- `limit`: integer `1..100`, default `25`.
- `cursor`: optional opaque cursor.

Order is version descending. The cursor contains the last version. Malformed cursors return `400`.

```json
{
  "items": [
    {
      "version": 2,
      "canonical_data": {},
      "provenance": {},
      "trigger": {
        "operation": "RECORD_UPDATED",
        "source_record_id": "uuid"
      },
      "canonicalization_version": "canonicalization-v1",
      "created_at": "2026-09-09T10:00:00.000Z"
    }
  ],
  "next_cursor": null
}
```

## Error Contract

Use the existing error envelope:

- `400`: malformed UUID, limit, or cursor.
- `401`: missing or invalid key.
- `403`: missing `entities:read`.
- `404`: absent or cross-tenant entity.
- `409`: conflicting source replay.
- `500`: unexpected failure without stack traces or customer payloads.

## Module Responsibilities

Add an `entities` module with a thin controller, tenant-scoped query service, pagination handling, response DTOs, and Swagger definitions.

Canonicalization is an application/domain service. It receives a transaction client, tenant ID, entity ID, trigger record ID, and trigger operation. Candidate extraction, completeness, ranking, and provenance construction stay pure and independently testable.

The ingestion service remains workflow owner and invokes canonicalization only after resolution has produced or confirmed a link.

## Migration and Compatibility

The migration:

1. Adds source priority with default `100` and its check.
2. Adds entity canonical version with default `0`.
3. Creates provenance/history tables, tenant-safe foreign keys, unique constraints, and indexes.

It does not fabricate provenance for existing entities. Existing canonical JSON remains readable at version 0. The next qualifying ingestion creates a `LEGACY_BACKFILL` from actual linked records.

Existing ingestion responses and resolution behavior remain unchanged. Changes to existing `/v1` responses are additive.

## Test Strategy

### Unit

- Person and Company extraction.
- Raw display values versus normalized identifiers.
- Null, missing, empty, whitespace-only, and Unicode values.
- Winners by priority, completeness, recency, and stable ID.
- Independent address-field winners.
- Deterministic output regardless of input order.
- Correct selection-rule attribution.
- No invented values.

### Integration and Security

- `NO_MATCH` creates entity version 1, current provenance, and one snapshot.
- `AUTO_MATCH` recomputes and appends a changed snapshot.
- `REVIEW` creates no canonical state.
- Updated linked record recomputes.
- Unchanged replay does not append history.
- Version-0 legacy entity backfills once.
- Provenance identifies the exact source record.
- Raw payloads remain unchanged.
- Concurrent ingestion produces sequential, unique versions.
- All reads are tenant isolated; foreign tenant IDs return `404`.
- Missing scope returns `403`; invalid and revoked key behavior remains intact.
- Records/history pagination is stable and bounded.
- Malformed pagination input returns `400`.
- Source priority default, validation, and replay conflicts work as specified.

### Contract, Migration, and Documentation

- Swagger includes all endpoints and response DTOs.
- Source schemas include priority.
- Existing ingestion contract tests remain green.
- Migration applies to an empty database and current pre-Day-4 schema.
- README and API docs explain priority, entity reads, survivorship, and manual testing.

## Acceptance Criteria

- Every newly linked entity receives deterministic canonical data and field provenance.
- Priority, completeness, recency, and stable tie-breaking are tested.
- Canonical changes create immutable sequential snapshots.
- Unchanged idempotent ingestion creates no duplicate history.
- Raw records remain preserved.
- All three read endpoints match the contracts above.
- Cross-tenant and missing-scope access is denied.
- Migration, unit, integration, lint, build, and contract checks pass.
