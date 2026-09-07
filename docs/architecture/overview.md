# Resolve API Architecture

Resolve is an npm-workspaces modular monolith. The API and worker run as separate processes and share focused TypeScript packages.

```text
Client -> NestJS API -> PostgreSQL
                     -> Redis

BullMQ worker ------> Redis
                  \-> PostgreSQL
```

`apps/api` owns HTTP concerns. `apps/worker` owns background execution. `packages/contracts` owns public types and validation, `packages/config` owns process configuration, and `packages/database` owns the Prisma schema, generated client, and migrations.

PostgreSQL is the durable source of truth. Redis supplies queue and coordination infrastructure and is safe to rebuild.

## Foundational persistence model

The Day 3 schema establishes six tables:

- `tenants` is the ownership and security boundary.
- `api_keys` stores key prefixes and hashes, never plaintext secrets.
- `source_systems` identifies the applications or datasets that supply records.
- `source_records` preserves raw source truth and stores separate normalized projections.
- `entities` stores canonical Person or Company representations.
- `entity_record_links` records which source record belongs to which canonical entity, with the score, decision, and algorithm version that produced the link.

Every tenant-owned relation carries `tenant_id`. Composite foreign keys require source records and links to reference objects from the same tenant. A source record is idempotently identified by `(tenant_id, source_system_id, external_id)`.

Raw, normalized, and canonical data remain distinct:

```text
source_records.raw_payload          immutable source truth
source_records.normalized_*         derived, versioned comparison values
entities.canonical_data             consolidated entity representation
entity_record_links                 explicit evidence-bearing association
```

The first blocking indexes support tenant-scoped lookup by normalized email, phone, company domain, and entity-type/name prefix. Candidate generation must use these indexed access patterns and remain bounded when it is implemented.

The resolution flow remains:

```text
INGEST -> NORMALIZE -> BLOCK -> COMPARE -> SCORE -> DECIDE
       -> CANONICALIZE -> PERSIST EVIDENCE -> NOTIFY
```

Day 3 defines storage and integrity rules only. It does not expose CRUD endpoints, authenticate API keys, ingest records, normalize input, resolve entities, or run matching jobs.
