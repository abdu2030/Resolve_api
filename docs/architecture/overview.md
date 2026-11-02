# Resolve API Architecture

## Review workflow boundary (Week 2 Day 6)

`reviews/` contains thin scoped controllers, bounded keyset queries, pure stale
evidence guards, public response mapping, and the decision transaction. GET detail
uses RepeatableRead so source/candidate data, evidence snapshots, and outcome agree.
It exposes original machine inputs separately from current data. No external calls
or queues participate in a review decision.

`review_cases` captures scored source/supporting record versions for new cases;
the additive migration leaves historical unknown versions null. Immutable
`review_decisions` records APPROVE/REJECT, actor/reason, original case, observed
versions, resulting entity/canonical version, and policy `review-v1`. Composite
tenant foreign keys protect case, actor, result, link, and canonical audit references;
one outcome per tenant/case and an UPDATE/DELETE guard prevent rewriting outcomes.
Raw source history, match features, and original case score/explanation are retained.

Lock order is idempotency -> exclusive `entity-membership:${tenantId}` -> canonical
entity lock. The existing ingestion shared gate and merge/split exclusive gate
coordinate with this operation; no shared-to-exclusive lock upgrade is attempted.
After locks, the service validates source version, unresolved/unlinked state, and
(for approval) ACTIVE same-type candidate, unchanged evidence record versions,
supporting membership, expected canonical version, and incrementability. Legacy
null evidence versions are safe only when both records remain version1. Rejection
uses current source data and does not depend on the candidate still being active.

Outcome insertion, new entity when rejected, link creation, case closure, forced
canonical snapshot/provenance recomputation, and response ledger commit atomically.
The canonical selection policy remains `canonicalization-v1`; review triggers
add audit context without changing ranking. Machine link evidence remains REVIEW;
its human-decision marker tells the resolver how to report the current linked
AUTO_MATCH/NO_MATCH result. Historical keyed responses remain unchanged.

The main read paths expose human audit references additively. Existing raw,
canonical, feature, and merge/split history survives later membership operations.
Day7 quality evaluation can compare the original machine outcome with the stored
human label without replacing either with the other. Scorer evaluation must filter
to matching captured/observed record versions; changed-version and legacy unknown
outcomes must not be treated as labels for the original scored pair.

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

All three `/v1/entities/:entityId` read routes require `entities:read`.
Bootstrap keys include this scope by default; narrower keys must request it
explicitly. Entity IDs never grant access across tenant boundaries.

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

The Week 2 Day 3 resolver now creates the first entity and links matching
records during ingestion. The checkpoint therefore also verifies that the CRM
record receives `NO_MATCH`, the billing and CSV duplicates receive
`AUTO_MATCH`, and all three resolve to the same tenant-local entity. Direct
blocking checks still return one bounded candidate with all four expected
signals and never expose the overlapping entity owned by the other tenant.

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
combination. Composite foreign keys prevent cross-tenant evidence. The scorer
remains side-effect free; the Day 3 API resolver owns its transactional use.

## Week 2 Day 3 resolver pipeline

`POST /v1/records` runs ingestion, normalization, blocking, comparison,
scoring, and decision persistence in one PostgreSQL transaction. The focused
`ResolutionService` uses the transaction-aware candidate generator so a
failure rolls back the record, raw version, evidence, entity link or review
case, and idempotency ledger together.

Every supporting source record returned by blocking is compared and persisted
in `match_features`. Candidate ranking uses full-precision scores and stable
entity/source-record tie breakers. The public confidence is rounded to four
decimal places. One automatic candidate links the incoming record to that
entity. Multiple automatic candidates produce `REVIEW` with a blocking
`MULTIPLE_AUTO_MATCH_CANDIDATES` contradiction. The strongest review
candidate creates one open `review_cases` row and no entity link. With no
acceptable candidate, the resolver creates an entity and links the incoming
record with `NO_MATCH`. The Day 4 canonicalizer now fills that entity in the
same transaction.

The response adds `entity_id`, `decision`, `confidence`, an optional
`matched_against` entity ID, structured `explanation`, and
`algorithm_version` to the ingestion fields. An existing link or review
case is replayed instead of creating duplicate decision side effects.

## Week 2 Day 4 canonicalization and entity reads

The API's canonicalization module applies pure, deterministic
`canonicalization-v1` survivorship synchronously inside ingestion:

```text
resolution link
  -> entity advisory lock
  -> linked-record projection
  -> deterministic survivorship
  -> entity + current provenance + immutable snapshot
```

After creating or confirming an accepted link, the canonicalizer acquires a
transaction-scoped PostgreSQL advisory lock derived from tenant and entity
IDs. It loads that tenant's currently linked records, latest normalized/raw
payloads, and source metadata. Field candidates rank by lower source priority,
higher field completeness, newer source-record update time, then smaller record
ID. Address components are independent. Lower source priority is more
authoritative; registration defaults to `100` and enforces `0..1000` in both
validation and the database.

`entities.canonical_version` starts at zero. A canonical data or provenance
change increments it, updates `canonical_data`, replaces current
`entity_field_provenance`, and appends one `entity_canonical_versions` snapshot
atomically. Snapshots retain winning raw/canonical values, source identity,
selection rule, completeness, observation time, normalization version, policy
version, and trigger. Composite tenant foreign keys protect all new relations;
the unique entity/version constraint is a final concurrency guard. PostgreSQL
remains the durable source of truth; no Redis cache or queue is authoritative
for canonical state.

`NO_MATCH` creates initial canonical state; `AUTO_MATCH` recomputes after
linking; changed linked payloads recompute the existing entity. `REVIEW` does
not canonicalize because no link is accepted. Unchanged positive-version
replays skip recomputation. A recomputation with identical data and provenance
creates no history. Legacy version-zero entities retain their stored JSON and
gain one `LEGACY_BACKFILL` on the next qualifying ingestion. Successful
idempotency-key replay returns its ledger response without running the workflow.
Canonicalization failure rolls back the entire ingestion transaction, including
raw versions, resolution evidence, links, and the idempotency ledger.

The entities module has a thin controller, tenant-scoped query service,
validated bounded pagination, and Swagger DTOs. `GET /v1/entities/:entityId`
reads canonical data, current provenance, record count, and latest policy
version in an interactive `RepeatableRead` transaction so concurrent commits
cannot mix versions in one response. The records route returns current raw and
normalized audit payloads with stored link evidence, ordered by link creation
time and ID descending. The history route returns immutable snapshots ordered
by version descending. Both pages default to 25 and cap at 100, using opaque
keyset cursors and one extra row to detect the next page.

All queries use authenticated tenant context; missing and cross-tenant IDs
return the same `404`. Reads perform no backfill or write. Version-zero reads
return the stored canonical object, empty provenance/history, and a null policy
version. Raw payloads are exposed only for authenticated audit use and must not
be logged. Manual field locks, source-priority updates, and background
recomputation remain outside this milestone.

## Week 2 Day 5 entity membership operations

The entities module now separates its read service from a thin mutation
controller and `EntityManagementService`. Contracts own validated request
types, `entity-operation-policy.ts` owns pure membership/state planning, and
`entity-operation.mapper.ts` maps database events to public snake_case audit
objects. The operation policy is `entity-operations-v1`; canonical extraction,
ranking, formatting, and provenance remain `canonicalization-v1`.

Merge retains the absorbed entity as a MERGED shell and moves existing links
to the ACTIVE target. A selected split creates a new ACTIVE ID; explicit
merge reversal restores the original source ID from recorded membership,
using latest source values. No raw record/version, matcher evidence, review
case, original link ID, or prior canonical snapshot is deleted or rewritten.
Blocking includes only ACTIVE candidates. Old IDs retain their own history
and reads do not redirect through merge chains.

`entity_operations` is append-only audit history with reason, authenticated
API-key actor, bounded/sorted member IDs, before/after versions, and an optional
reversed-operation reference. Composite tenant foreign keys protect actor,
source, target, reversal, link last-operation references, and canonical
snapshot operation references. Database checks enforce lifecycle, event
shape, and version/count constraints; uniqueness permits one reversal per
merge. No external queue or cache participates in transaction correctness.

Concurrency uses PostgreSQL transaction advisory locks in this order:

1. Tenant/idempotency key, when supplied for ingestion and required for mutations.
2. Tenant membership gate, exactly `entity-membership:${tenantId}`.
3. Existing source-record locks for ingestion.
4. Canonicalization entity locks, sorted by ID for multi-entity mutations,
   using `canonicalization:${tenantId}:${entityId}`.

Ingestion takes a shared membership gate before source-record writes;
independently invoked resolution takes the same shared gate on entry.
Merge/split take its exclusive mode before membership reads or writes.
Concurrent ingestions can proceed; a manual action serializes membership
changes within its tenant. Other tenants have independent gates. State,
versions, and membership are validated under those locks. Events and newly
created entities precede referencing writes; links/statuses, both canonical
projections/snapshots, and the idempotency ledger commit atomically.

Membership reads stop at 1001 rows. Operations reject combined merge
membership or current split/reversal membership above 1000 with 422, bounding
audit payloads and synchronous recomputation. Each success appends exactly
two structural canonical snapshots (MERGE, or SPLIT for split/reversal),
including unchanged winners. Existing ingestion no-op behavior stays intact.
Failures roll back every operation effect, including its replay ledger.

Reversal requires the exact original source to remain MERGED directly into
the target, all recorded members still there, and a nonempty remaining target.
It appends UNMERGE and preserves MERGE; it never restores an old source
snapshot. Reverse merge chains in reverse order. Successful keyed replay
returns historical status/body without repeating writes, even after later
membership changes. Fresh reads show current state. Historical review
candidates/evidence stay intact; the review service checks stale evidence and
merged/moved candidates before approval.

See the [operation contract](../contracts/mvp-v1.md#manual-entity-operations-entity-operations-v1)
and [manual PowerShell guide](../testing/week2-day5-merge-split-powershell.md).
