# Day 6 Blocking v1 Design

## Status and goal

Approved in chat on 2026-09-08. Implement the first tenant-safe, indexed,
bounded candidate-generation subsystem for existing canonical Person and
Company entities.

Blocking v1 runs four passes in priority order:

1. exact normalized email;
2. exact normalized phone;
3. exact company domain;
4. exact stored normalized-name prefix plus normalized city and country.

It unions all enabled passes, deduplicates by entity, preserves the evidence
that found each candidate, and applies a hard final cap.

Day 6 adds internal application functionality only. It does not add an HTTP
endpoint, alter `POST /v1/records`, score candidates, make match decisions,
create entities, create links, canonicalize data, or add fuzzy matching.

## Chosen architecture

Add `apps/api/src/blocking` with:

- `blocking.types.ts` for versioned internal contracts;
- `blocking-policy.ts` for `blocking-v1` and signal priority;
- `blocking.queries.ts` for four parameterized PostgreSQL query builders;
- `candidate-collector.ts` for pure union, deduplication, evidence accumulation,
  ordering, and capping;
- `candidate-generation.service.ts` for tenant-scoped loading and query
  execution;
- `blocking.module.ts` to register and export the service for later stages.

Use explicit Prisma SQL query builders. This makes tenant predicates, limits,
joins, and index-compatible conditions directly reviewable and lets tests pass
the exact production queries to `EXPLAIN (FORMAT JSON)`.

Prisma relation filters were rejected because generated SQL is less predictable
for plan verification. Denormalizing blocking keys onto entities was rejected
because canonicalization and its synchronization rules do not exist yet.

## Internal contract

The service exposes:

```ts
findCandidates(
  tenantId: string,
  sourceRecordId: string,
): Promise<BlockingResult>
```

The result is:

```ts
type BlockingSignal = 'EXACT_EMAIL' | 'EXACT_PHONE' | 'COMPANY_DOMAIN' | 'NAME_LOCATION';

interface BlockingCandidate {
  entityId: string;
  entityType: 'PERSON' | 'COMPANY';
  matchedOn: BlockingSignal[];
  supportingRecordIds: string[];
}

interface BlockingResult {
  blockingVersion: 'blocking-v1';
  candidates: BlockingCandidate[];
  truncated: boolean;
}
```

`tenantId` comes from authenticated application context, never raw record
data. The service loads the source record using both tenant ID and source
record ID and selects only normalized projections. A missing record throws
`CandidateSourceRecordNotFoundError` without revealing cross-tenant existence.

## Candidate source and isolation

Candidates are existing entities reached through:

```text
source_records -> entity_record_links -> entities
```

Every join and predicate carries `tenant_id`. Supporting records and
candidate entities must match the incoming entity type. The incoming source
record is excluded, while other records linked to the same entity remain valid
evidence. Unlinked source records are not candidates.

## Blocking passes

### Exact email

Run only when `normalized_email` is non-null. Match with equality against
`source_records_tenant_normalized_email_idx`. Equality remains case-sensitive
because normalization preserves the email local part's case.

### Exact phone

Run only when `normalized_phone` is non-null. Match E.164 values with equality
against `source_records_tenant_normalized_phone_idx`.

### Company domain

Run only when `company_domain` is non-null. Match the normalized ASCII domain
with equality against `source_records_tenant_company_domain_idx`.

This pass is available to both entity types. For a Person it generates a
candidate but is not proof of identity. Later scoring must treat a shared
company domain as weak evidence.

### Name and location fallback

Run only when all three values are present:

- `normalized_name_prefix`;
- `normalized_payload.address.city` as a non-empty string;
- `normalized_payload.address.country` as a non-empty string.

Match all three values exactly. The indexed access predicate is
`(tenant_id, entity_type, normalized_name_prefix)` and must use
`source_records_tenant_type_name_prefix_idx`. City and country are JSONB
filters applied after the indexed name lookup.

Requiring both location components makes v1 conservative and prevents a
name-only tenant scan. Region-only, postal-only, partial-name, and fuzzy-name
fallbacks are outside Day 6.

## SQL safety and bounds

Every query is parameterized with Prisma SQL values. No tenant ID, record ID,
signal value, or limit is concatenated into SQL.

Prisma raw SQL does not inherit the adapter's configured schema. Query builders
therefore safely quote and qualify static table and enum names using the
trusted `schema` value from `DATABASE_URL`. User-controlled values remain
bound parameters.

Each pass requests at most `BLOCKING_MAX_CANDIDATES + 1` distinct entity
rows. The extra row detects pass overflow without an unbounded count. The
configured maximum is restricted to 1 through 1000, so each pass fetches at
most 1001 rows and the four-pass total remains bounded independently of tenant
size.

Each pass returns one deterministic supporting source-record ID per entity.
SQL orders by entity ID and source-record ID before applying `DISTINCT ON`
and `LIMIT`.

## Union, deduplication, and ordering

Passes are collected in this fixed priority:

1. `EXACT_EMAIL`;
2. `EXACT_PHONE`;
3. `COMPANY_DOMAIN`;
4. `NAME_LOCATION`.

The first appearance establishes candidate position. Later passes add their
signal and supporting record without duplicating the entity. Within a pass,
entity and record IDs are ascending. `matchedOn` follows signal priority and
`supportingRecordIds` follows deduplicated first-observation order.

After collecting every enabled pass, return the first configured number of
entities. `truncated` is true when any pass returned its overflow row or the
union exceeded the final cap. It is an overflow indicator, not a total count;
blocking never runs an unbounded `COUNT(*)`.

## Configuration

Add `BLOCKING_MAX_CANDIDATES=100` to `.env.example` and
`EnvironmentConfig`.

Accept only decimal integers from 1 through 1000. Default to 100 when absent
so existing environments remain compatible. Reject present but blank,
fractional, negative, zero, or out-of-range values without echoing them.

The configuration package owns the default and maximum constants so validation
has one source of truth.

No signal weights or decision thresholds belong here because blocking does
not score candidates.

## Database schema and query plans

No migration is planned. The required indexes already exist:

```text
source_records_tenant_normalized_email_idx
source_records_tenant_normalized_phone_idx
source_records_tenant_company_domain_idx
source_records_tenant_type_name_prefix_idx
```

The joins use existing tenant-scoped link and entity indexes. If plan tests
prove an index insufficient, implementation must stop and revise this design
before adding a new access path.

PostgreSQL integration tests deploy migrations in an isolated schema, seed a
statistically meaningful set of selective distractor rows, run `ANALYZE`,
and execute `EXPLAIN (FORMAT JSON)` against the exact production query
builders.

For each pass, tests assert:

- the plan names the expected source-record blocking index;
- no `Seq Scan` node targets `source_records`;
- the real service returns the intended candidate.

Tests do not disable sequential scans. The planner must choose the index under
the seeded distribution normally. Plan inspection is structural and does not
assert unstable costs or formatting.

## Testing

Unit tests cover:

- four-pass union and entity deduplication;
- signal accumulation in priority order;
- supporting-record deduplication;
- deterministic ordering;
- final cap behavior;
- pass and union overflow reporting;
- configuration default, minimum, maximum, and invalid values.

Real PostgreSQL integration tests cover:

- exact email, phone, and domain discovery;
- name, city, and country fallback;
- skipped passes when normalized values are absent;
- self-record and unlinked-record exclusion;
- same-type filtering;
- cross-tenant isolation;
- multi-signal evidence on one entity;
- deterministic capping and truncation;
- all four expected query plans.

Tests seed entities and links directly because automatic entity creation is
outside Day 6.

Before review, run:

```text
npm run prisma:validate
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
docker compose config --quiet
```

## Documentation

Update the architecture documentation with the internal blocking boundary,
version, passes, and linked-entity rule. Update the README milestone and
configuration table. Swagger does not change because there is no public
endpoint.

## Acceptance criteria

Day 6 is ready for review when:

- only same-tenant, same-type linked entities are candidates;
- all four normalized blocking passes work;
- each pass and the final union are bounded;
- entity candidates are deduplicated with explainable supporting evidence;
- overflow is reported without an unbounded count;
- plans use the four expected indexes with no source-record sequential scan;
- no public API or matching-decision behavior changes;
- documentation and all verification commands pass.
