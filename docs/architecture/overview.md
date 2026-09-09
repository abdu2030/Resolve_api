# Resolve API Architecture

Resolve is an npm-workspaces modular monolith. The API and worker run as
separate processes and share focused TypeScript packages.

```text
Client -> NestJS API -> PostgreSQL
                     -> Redis

BullMQ worker ------> Redis
                  \-> PostgreSQL
```

`apps/api` owns HTTP concerns. `apps/worker` owns background execution.
`packages/contracts` owns public types and validation, `packages/config`
owns process configuration, `packages/database` owns the Prisma schema,
generated client, and migrations, and `packages/normalization` owns pure,
versioned normalization rules. The API's `blocking` module owns indexed,
bounded candidate generation.

PostgreSQL is the durable source of truth. Redis supplies queue and
coordination infrastructure and is safe to rebuild.

## Persistence and ingestion model

Days 3 and 4 establish eight tenant-owned tables:

- `tenants` is the ownership and security boundary.
- `api_keys` stores key prefixes and hashes, never plaintext secrets.
- `source_systems` identifies the applications or datasets that supply records.
- `source_records` holds the stable source identity, current raw payload, and separate normalized projections.
- `entities` stores canonical Person or Company representations.
- `entity_record_links` records which source record belongs to which canonical entity, with the score, decision, and algorithm version that produced the link.
- `source_record_versions` preserves every accepted raw payload version as immutable history.
- `idempotency_requests` stores successful replayable responses for tenant-scoped idempotency keys.

Every tenant-owned relation carries `tenant_id`. Composite foreign keys
require source records and links to reference objects from the same tenant. A
source record is idempotently identified by
`(tenant_id, source_system_id, external_id)`.

Current raw data, raw history, normalized projections, and canonical data
remain distinct:

```text
source_records.raw_payload          current source payload
source_record_versions.raw_payload  immutable source history
source_records.normalized_*         derived, versioned comparison values
entities.canonical_data             consolidated entity representation
entity_record_links                 explicit evidence-bearing association
```

The first blocking indexes support tenant-scoped lookup by normalized email,
phone, company domain, and entity-type/name prefix. `blocking-v1` uses these
access patterns directly and verifies them with real PostgreSQL query plans.

The resolution flow remains:

```text
INGEST -> NORMALIZE -> BLOCK -> COMPARE -> SCORE -> DECIDE
       -> CANONICALIZE -> PERSIST EVIDENCE -> NOTIFY
```

## Authentication and request boundary

Every protected request supplies `Authorization: Bearer <api-key>`. The API
hashes the full credential, loads its tenant and scopes, rejects revoked keys
and inactive tenants, and never accepts a tenant ID from the request body.
`POST /v1/sources` requires `sources:write`; `POST /v1/records` requires
`records:write`.

Source registration and record ingestion use PostgreSQL transactions and
transaction-scoped advisory locks. Source locks key on tenant and source name.
Ingestion acquires an optional tenant/idempotency lock before the
tenant/source/external-record lock. Database uniqueness constraints remain the
final concurrency guard.

Record ingestion preserves the submitted `data` object from the original JSON
bytes before DTO transformations. A canonical JSON hash detects logical
equality across object-key order. An identical payload returns `UNCHANGED`; a
changed payload inserts the next `source_record_versions` row and updates the
stable `source_records` snapshot. An entity-type change returns a conflict.

The API stores a successful response with an optional tenant-scoped
`Idempotency-Key`. Repeating the same key and request returns that status and
body. Reusing the key for another request returns a conflict. Failed
transactions create no ledger row.

## Day 5 normalization boundary

After source lookup and record locking, the API passes the preserved raw data
to `@resolve/normalization`. The package performs deterministic, local,
`normalization-v1` work without database or framework dependencies.

The ingestion transaction atomically stores the raw snapshot, immutable raw
history, normalized payload, normalization version, and indexed normalized
projections. Changed raw input recomputes all projections. Unchanged input
already on the current version performs no write; missing or older derived
state is refreshed without creating a raw version.

Day 5 does not generate candidates, score matches, create canonical entities,
or link records.

## Day 6 blocking boundary

`CandidateGenerationService` accepts a trusted tenant ID and source-record
ID, loads only that tenant's normalized projections, and runs enabled passes in
this order:

1. exact normalized email;
2. exact normalized phone;
3. exact company domain;
4. exact normalized-name prefix with normalized city and country.

Each pass searches normalized source records already connected to canonical
entities through `entity_record_links`. Supporting records and entities must
belong to the same tenant and have the incoming record's entity type. The
incoming record itself and unlinked records are excluded.

Every enabled pass fetches at most `BLOCKING_MAX_CANDIDATES + 1` distinct
entities. The extra row detects overflow. Results are unioned in signal
priority, deduplicated by entity ID, and finally capped at the configured
maximum, which defaults to 100 and cannot exceed 1000. Candidates retain their
blocking signals and supporting record IDs, and the result records
`blocking-v1` plus a truncation flag.

The exact production queries are exercised with `EXPLAIN (FORMAT JSON)`.
Integration tests require PostgreSQL to choose the email, phone, domain, and
name-prefix indexes without disabling sequential scans.

Prisma raw SQL does not inherit the adapter schema, so the query builders
safely qualify static table and enum names from the trusted `DATABASE_URL`
schema. Tenant IDs and all record-derived values remain bound parameters.

Day 6 does not expose blocking over HTTP, invoke it from ingestion, score
candidates, make decisions, create entities, or change entity links.

## Day 7 integration checkpoint

The Day 7 checkpoint exercises the existing API and blocking service as one
flow against an isolated, fully migrated PostgreSQL schema. Its
`day7-integration-v1` fixture supplies deliberately different CRM, billing,
and CSV representations of one person plus an overlapping record owned by a
second tenant.

The checkpoint registers sources and ingests records through the authenticated
HTTP API. It then verifies the stored raw payloads, literal
`normalization-v1` payloads and projections, immutable version rows, and
idempotency ledger. Replaying every request must return its original response
without changing record timestamps or increasing record, version, or ledger
counts.

Automatic entity creation and matching are outside the implemented roadmap
boundary, so the test creates explicit fixture entities and links after
ingestion. The production `CandidateGenerationService` must then return one
tenant-local candidate for the billing and CSV records, with all four expected
blocking signals, while excluding the linked entity owned by the other tenant.
The linked CRM record itself returns no candidates because the billing and CSV
records remain unlinked and blocking excludes the CRM record from matching
itself.

Day 7 adds no endpoint, schema migration, scoring rule, matching decision, or
production-side entity link.
