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
versioned normalization rules. `packages/matching` owns pure comparators and
versioned evidence extraction. The API's `blocking` module owns indexed,
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

## Week 2 Day 1 matching evidence boundary

`@resolve/matching` is a deterministic, side-effect-free package. It accepts
two `ComparisonRecord` values with the same entity type, reads normalized
values produced by `@resolve/normalization`, and returns `features-v1` evidence
plus structured contradictions. Registration identifiers are conservatively
prepared from the preserved raw payload because `normalization-v1` does not
project that field. The package has no NestJS, Prisma, Redis, queue, network,
or persistence dependency and does not mutate its inputs.

The five comparator families are:

1. **Exact equality.** If either prepared value is absent or blank, the result
   is `null`; otherwise the result is `left === right`. Domain equality uses
   this formula on normalized domains.
2. **Normalized edit similarity.** For Unicode code-point sequences, let `d`
   be their Levenshtein distance and `L = max(length(left), length(right))`.
   The result is `clamp(1 - d / L, 0, 1)`. Equal present values return `1`;
   missing values return `null`.
3. **Jaro-Winkler similarity.** With matched characters `m`, half the number
   of out-of-order matched characters `t / 2`, and string lengths `|left|`
   and `|right|`, `J = (m / |left| + m / |right| + (m - t / 2) / m) / 3`.
   When `J >= 0.7`, the result is
   `clamp(J + l * 0.1 * (1 - J), 0, 1)`, where `l` is the shared prefix length
   capped at four; otherwise the result is `J`. No matches return `0`, and
   missing values return `null`.
4. **Token-set Jaccard similarity.** Split each prepared string on whitespace
   into unique tokens `A` and `B`; the result is
   `|A intersect B| / |A union B|`. Missing values return `null`.
5. **Structured domain/address comparison.** Domain comparison applies exact
   equality to normalized domains. Address similarity joins the present
   `line1`, `line2`, `city`, `region`, `postal_code`, and `country` fields in
   that fixed order and applies token-set Jaccard. Country comparison applies
   exact equality to the normalized `address.country` values.

`features-v1` has a stable, null-filled shape so unavailable evidence is
different from disagreement. Person evidence contains:

- `email_exact`
- `phone_exact`
- `name_edit_similarity`
- `name_jaro_winkler_similarity`
- `company_name_token_similarity`
- `company_domain_exact`
- `address_token_similarity`
- `country_exact`

Company evidence contains:

- `email_exact`
- `phone_exact`
- `company_name_edit_similarity`
- `company_name_jaro_winkler_similarity`
- `company_name_token_similarity`
- `domain_exact`
- `address_token_similarity`
- `country_exact`
- `registration_id_exact`

When both comparable values are present and disagree, `EMAIL_CONFLICT`,
`PHONE_CONFLICT`, `COMPANY_DOMAIN_CONFLICT`, and `COUNTRY_CONFLICT` are
warning contradictions. `REGISTRATION_ID_CONFLICT` is blocking because two
different trusted company registration identifiers must prevent automatic
matching. Missing values produce neither equality nor a contradiction.

Week 2 Day 1 ends at evidence extraction. Its golden tests assert evidence
without making a decision.

Run the milestone package suite with:

```powershell
npm run test -- packages/matching/test
```

## Week 2 Day 2 scoring and decision policy

`scoreFeatures` consumes one `features-v1` result and applies
`rules-0.1.0`. It groups fields into email, phone, name, company, and
location signals. Each group uses its strongest available positive signal.
The scorer renormalizes the `0.40`, `0.25`, `0.20`, `0.10`, and `0.05`
weights across groups with evidence, so missing fields do not count as
disagreement.

Each warning contradiction subtracts `0.15`. The scorer clamps the result to
`0..1` and applies inclusive thresholds: `0.92` selects `AUTO_MATCH`,
`0.72` selects `REVIEW`, and lower scores select `NO_MATCH`. A blocking
contradiction changes an otherwise automatic match to `REVIEW`.

The result retains the source feature vector, contradictions, grouped signals,
weights, contributions, active weight, penalty, thresholds, and policy
version. The `match_features` table stores these inputs and explanations for
an exact source-record, candidate-source-record, and candidate-entity
combination. Composite foreign keys prevent cross-tenant evidence. This
milestone does not connect scoring to record ingestion, create entity links,
or expose a new route.
