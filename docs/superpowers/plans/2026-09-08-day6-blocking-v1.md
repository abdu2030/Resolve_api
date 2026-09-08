# Day 6 Blocking v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build tenant-safe, indexed, bounded candidate generation for linked Person and Company entities.

**Architecture:** A NestJS blocking module loads one normalized source record, runs up to four explicit parameterized PostgreSQL queries through Prisma, and passes bounded rows to a pure entity-level collector. The service returns a versioned internal result with signals, supporting records, and truncation state; it does not alter ingestion or expose an HTTP route.

**Tech Stack:** NestJS 11, TypeScript 5.9, Prisma 7, PostgreSQL, Jest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-08-day6-blocking-v1-design.md`

## Global Constraints

- Blocking version is exactly `blocking-v1`.
- Signal priority is `EXACT_EMAIL`, `EXACT_PHONE`, `COMPANY_DOMAIN`, then `NAME_LOCATION`.
- Every database query includes tenant ID, entity type, incoming-record exclusion, deterministic ordering, and a hard limit.
- `BLOCKING_MAX_CANDIDATES` defaults to 100 and accepts only integers from 1 through 1000.
- Name/location runs only with normalized name prefix, city, and country.
- Candidates must already be linked entities; Day 6 creates no entities or links.
- No public API, matching score, decision, or database migration is added.
- Follow strict red-green-refactor for production behavior.
- Do not create intermediate commits. Keep all Day 6 work uncommitted until user review and approval.

---

### Task 1: Configuration and blocking contracts

**Files:**

- Modify: `packages/config/src/environment.ts`
- Modify: `packages/config/test/environment.spec.ts`
- Modify: `.env.example`
- Create: `apps/api/src/blocking/blocking-policy.ts`
- Create: `apps/api/src/blocking/blocking.types.ts`

**Interfaces:**

- Produces: `EnvironmentConfig.blockingMaxCandidates: number`
- Produces: `BLOCKING_VERSION`, `BLOCKING_SIGNAL_PRIORITY`, `BlockingSignal`
- Produces: `BlockingCandidate`, `BlockingResult`, `BlockingQueryRow`, and `BlockingPassRows`

- [x] **Step 1: Add failing configuration tests**

Extend the valid expected object with `blockingMaxCandidates: 100`. Add literal
cases proving absent defaults to 100, `1` and `1000` are accepted, and the
following supplied values are rejected without being echoed:

```ts
it.each([
  ['blank', ''],
  ['zero', '0'],
  ['negative', '-1'],
  ['fractional', '1.5'],
  ['too large', '1001'],
  ['non-numeric', 'many'],
])('rejects %s BLOCKING_MAX_CANDIDATES', (_, value) => {
  const environment = { ...validEnvironment, BLOCKING_MAX_CANDIDATES: value };
  const message = captureErrorMessage(() => validateEnvironment(environment));
  expect(message).toContain('BLOCKING_MAX_CANDIDATES');
  if (value) expect(message).not.toContain(value);
});
```

- [x] **Step 2: Run the configuration test and verify RED**

Run:

```powershell
npm.cmd test -- packages/config/test/environment.spec.ts
```

Expected: failure because `blockingMaxCandidates` is missing and invalid
blocking-limit values are not rejected.

- [x] **Step 3: Implement strict optional integer parsing**

Add `blockingMaxCandidates` to `EnvironmentConfig`. Implement an optional
decimal-integer parser that returns 100 only when the key is absent and rejects
every present invalid value:

```ts
function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  defaultValue: number,
  maximum: number,
): number {
  const value = input[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return invalid(key);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    return invalid(key);
  }
  return parsed;
}
```

Return `blockingMaxCandidates: optionalInteger(input,
'BLOCKING_MAX_CANDIDATES', 100, 1000)` and add
`BLOCKING_MAX_CANDIDATES=100` to `.env.example`.

- [x] **Step 4: Add the exact internal contracts**

`blocking-policy.ts` defines:

```ts
export const BLOCKING_VERSION = 'blocking-v1' as const;
export const BLOCKING_SIGNAL_PRIORITY = [
  'EXACT_EMAIL',
  'EXACT_PHONE',
  'COMPANY_DOMAIN',
  'NAME_LOCATION',
] as const;
```

`blocking.types.ts` derives `BlockingSignal` from the priority tuple and
defines the spec shapes. `BlockingQueryRow` contains `entityId`,
`entityType`, and `supportingRecordId`. `BlockingPassRows` contains one
`signal` and its `rows`.

- [x] **Step 5: Verify GREEN and formatting**

```powershell
npm.cmd test -- packages/config/test/environment.spec.ts
npm.cmd run format:check
```

Expected: configuration tests pass. If formatting fails, run `npm.cmd run
format` and rerun the focused test.

- [x] **Step 6: Review checkpoint**

Inspect `git diff` for Task 1. Do not commit.

---

### Task 2: Pure candidate collector

**Files:**

- Create: `apps/api/src/blocking/candidate-collector.ts`
- Create: `apps/api/src/blocking/candidate-collector.spec.ts`

**Interfaces:**

- Consumes: `BlockingPassRows[]` and configured maximum
- Produces: `collectCandidates(passes, maximum): Pick<BlockingResult, 'candidates' | 'truncated'>`

- [x] **Step 1: Write failing collector tests**

Use literal rows and UUID-shaped strings. Each test names the production break:

```ts
it('unions passes and accumulates evidence once per entity', () => {
  expect(
    collectCandidates(
      [
        {
          signal: 'EXACT_EMAIL',
          rows: [{ entityId: 'entity-a', entityType: 'PERSON', supportingRecordId: 'record-a' }],
        },
        {
          signal: 'EXACT_PHONE',
          rows: [
            { entityId: 'entity-a', entityType: 'PERSON', supportingRecordId: 'record-b' },
            { entityId: 'entity-b', entityType: 'PERSON', supportingRecordId: 'record-c' },
          ],
        },
      ],
      10,
    ),
  ).toEqual({
    candidates: [
      {
        entityId: 'entity-a',
        entityType: 'PERSON',
        matchedOn: ['EXACT_EMAIL', 'EXACT_PHONE'],
        supportingRecordIds: ['record-a', 'record-b'],
      },
      {
        entityId: 'entity-b',
        entityType: 'PERSON',
        matchedOn: ['EXACT_PHONE'],
        supportingRecordIds: ['record-c'],
      },
    ],
    truncated: false,
  });
});
```

Add separate tests proving duplicate supporting IDs are removed, the first
signal establishes ordering, `maximum + 1` rows mark pass overflow, and a
cross-pass union larger than the maximum marks union overflow.

- [x] **Step 2: Run the collector test and verify RED**

```powershell
npm.cmd test -- apps/api/src/blocking/candidate-collector.spec.ts
```

Expected: failure because the collector module does not exist.

- [x] **Step 3: Implement the minimal collector**

Iterate passes in the supplied order. For each pass, mark overflow when
`rows.length > maximum`, process only `rows.slice(0, maximum)`, and use a
`Map<string, BlockingCandidate>`.

For a new entity, create the candidate with the current signal and record. For
an existing entity, append only missing signals and record IDs. After all
passes, convert the map to an array, mark overflow when its length exceeds the
maximum, and slice to the final maximum.

Do not sort in the collector: query rows and pass order already provide the
documented deterministic order.

- [x] **Step 4: Verify GREEN**

```powershell
npm.cmd test -- apps/api/src/blocking/candidate-collector.spec.ts
```

Expected: all collector tests pass.

- [x] **Step 5: Mutation review**

Confirm tests fail conceptually if pass order is reversed, deduplication is
removed, the slice is removed, or overflow ignores the extra row. Do not add
source-text assertions.

- [x] **Step 6: Review checkpoint**

Inspect Task 2's diff. Do not commit.

---

### Task 3: Parameterized query builders

**Files:**

- Create: `apps/api/src/blocking/blocking.queries.ts`
- Create: `apps/api/src/blocking/blocking.queries.spec.ts`

**Interfaces:**

- Produces: one builder for email, phone, domain, and name/location
- Produces: `BLOCKING_QUERY_INDEXES` mapping each signal to its expected index

- [x] **Step 1: Write failing query-bound tests**

Tests call each builder with literal tenant, record, entity-type, signal, and
limit values. Assert on Prisma SQL's parameter values rather than matching the
entire SQL string:

```ts
const query = exactEmailQuery({
  tenantId: '11111111-1111-1111-1111-111111111111',
  sourceRecordId: '22222222-2222-2222-2222-222222222222',
  entityType: 'PERSON',
  value: 'User@example.com',
  limit: 101,
});

expect(query.values).toEqual([
  '11111111-1111-1111-1111-111111111111',
  'PERSON',
  '22222222-2222-2222-2222-222222222222',
  'User@example.com',
  101,
]);
```

Add cases for phone, domain, and name/location. These tests catch missing
parameters and accidental interpolation; integration tests verify behavior and
plans.

- [x] **Step 2: Run query tests and verify RED**

```powershell
npm.cmd test -- apps/api/src/blocking/blocking.queries.spec.ts
```

Expected: failure because query builders do not exist.

- [x] **Step 3: Implement the shared indexed query shape**

Each builder composes a signal predicate into this parameterized structure:

```sql
SELECT DISTINCT ON (link.entity_id)
  link.entity_id AS "entityId",
  entity.entity_type AS "entityType",
  supporting.id AS "supportingRecordId"
FROM source_records AS supporting
JOIN entity_record_links AS link
  ON link.tenant_id = supporting.tenant_id
 AND link.source_record_id = supporting.id
JOIN entities AS entity
  ON entity.tenant_id = link.tenant_id
 AND entity.id = link.entity_id
WHERE supporting.tenant_id = <tenant UUID>
  AND supporting.entity_type = <entity_type>
  AND entity.entity_type = <entity_type>
  AND supporting.id <> <incoming UUID>
  AND <indexed signal predicate>
ORDER BY link.entity_id ASC, supporting.id ASC
LIMIT <bounded limit>
```

Email, phone, and domain use equality on their scalar projection. Name/location
uses equality on `normalized_name_prefix` plus:

```sql
supporting.normalized_payload #>> '{address,city}' = <city>
AND supporting.normalized_payload #>> '{address,country}' = <country>
```

Use `Prisma.sql` for all composition and values. Cast tenant and record
parameters to UUID and entity type to the PostgreSQL `entity_type` enum.

- [x] **Step 4: Verify GREEN**

```powershell
npm.cmd test -- apps/api/src/blocking/blocking.queries.spec.ts
```

Expected: all query contract tests pass.

- [x] **Step 5: Review checkpoint**

Inspect the SQL for tenant predicates, type predicates, incoming-record
exclusion, deterministic order, and parameterized limit. Do not commit.

---

### Task 4: Candidate-generation service and module

**Files:**

- Create: `apps/api/src/blocking/candidate-source-record-not-found.error.ts`
- Create: `apps/api/src/blocking/candidate-generation.service.ts`
- Create: `apps/api/src/blocking/blocking.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `tests/integration/day6-blocking.integration.ts`

**Interfaces:**

- Consumes: Prisma client, `EnvironmentConfig.blockingMaxCandidates`, query builders, collector
- Produces: injectable and exported `CandidateGenerationService`

- [x] **Step 1: Add the failing integration behavior tests**

Create an isolated migrated PostgreSQL schema and Nest application using the
existing integration-test lifecycle. Set `BLOCKING_MAX_CANDIDATES=2` before
creating the application.

Seed incoming records, supporting records, entities, and links directly.
Assert the real service returns literal results for:

- one entity found through email, phone, domain, and name/location with all
  four signals in priority order;
- duplicate records for one entity without a duplicate candidate;
- an identical cross-tenant signal excluded;
- a different entity type excluded;
- an unlinked record excluded;
- the incoming record excluded from supporting evidence;
- absent city or country skipping NAME_LOCATION;
- more than two candidates returning exactly two and `truncated: true`;
- an unknown or cross-tenant source-record ID throwing
  `CandidateSourceRecordNotFoundError`.

- [x] **Step 2: Run the Day 6 integration test and verify RED**

```powershell
npm.cmd run test:integration -- tests/integration/day6-blocking.integration.ts
```

Expected: failure because the blocking service and module do not exist.

- [x] **Step 3: Implement source loading and location narrowing**

Load with the tenant-scoped `tenantId_id` unique key. Select only normalized
columns. Extract city and country only when `normalizedPayload` is a plain
object containing a plain `address` object and both properties are non-empty
strings. Never fall back to raw payload values.

- [x] **Step 4: Execute all enabled bounded passes**

Read the configured maximum, set `fetchLimit = maximum + 1`, construct enabled
queries in priority order, and run each with:

```ts
this.prisma.$queryRaw<BlockingQueryRow[]>(query);
```

Pass every result to `collectCandidates`. Return its values plus
`blockingVersion: BLOCKING_VERSION`. Missing normalized values skip only
their own query.

- [x] **Step 5: Register the module**

Provide and export `CandidateGenerationService` from `BlockingModule`.
Import `BlockingModule` in `AppModule`. Add no controller.

- [x] **Step 6: Verify GREEN**

```powershell
npm.cmd run test:integration -- tests/integration/day6-blocking.integration.ts
npm.cmd test -- apps/api/src/blocking
```

Expected: Day 6 integration and all blocking unit tests pass.

- [x] **Step 7: Review checkpoint**

Inspect tenant/type isolation, disabled-pass behavior, and maximum-plus-one
bounds. Do not commit.

---

### Task 5: Query-plan proof

**Files:**

- Modify: `tests/integration/day6-blocking.integration.ts`

**Interfaces:**

- Consumes: the exact four production query builders
- Produces: structural proof that PostgreSQL chooses each expected index

- [x] **Step 1: Add failing plan assertions**

In the isolated schema, bulk-seed at least 2,000 linked distractor entities and
records with selective email, phone, domain, and name-prefix values. Run:

```sql
ANALYZE source_records;
ANALYZE entity_record_links;
ANALYZE entities;
```

For each production query, execute `EXPLAIN (FORMAT JSON)` through the schema-
scoped Prisma client. Recursively collect plan nodes and assert:

```ts
expect(indexNames).toContain(BLOCKING_QUERY_INDEXES.EXACT_EMAIL);
expect(
  nodes.some(
    (node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'source_records',
  ),
).toBe(false);
```

Repeat with the phone, domain, and name/location expected indexes. Do not set
`enable_seqscan` to off.

- [x] **Step 2: Run the plan test and verify RED if an access path is wrong**

```powershell
npm.cmd run test:integration -- tests/integration/day6-blocking.integration.ts
```

Expected before final tuning: either all plan assertions pass, or a precise
failure names the access path PostgreSQL did not select.

- [x] **Step 3: Tune only the query shape or fixture distribution**

If a plan fails, inspect the JSON plan. Correct predicates so their leading
columns match the existing indexes. Use a realistic selective fixture
distribution and `ANALYZE`; do not force index use and do not add an index
without revising the approved design.

- [x] **Step 4: Verify GREEN twice**

```powershell
npm.cmd run test:integration -- tests/integration/day6-blocking.integration.ts
npm.cmd run test:integration -- tests/integration/day6-blocking.integration.ts
```

Expected: both runs name every expected index and contain no source-record
sequential scan.

- [x] **Step 5: Review checkpoint**

Confirm the plan test imports the production query builders instead of copying
their SQL. Do not commit.

---

### Task 6: Documentation and complete verification

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/superpowers/plans/2026-09-08-day6-blocking-v1.md`

**Interfaces:**

- Documents: blocking-v1 behavior, configuration, boundaries, and testing

- [x] **Step 1: Update documentation**

Set the README milestone to Days 1 through 6. Add `BLOCKING_MAX_CANDIDATES`
with default 100 and range 1 through 1000 to setup/configuration documentation.
Add the blocking module to the repository structure.

In the architecture note, document the four priority passes, tenant/type
isolation, linked-entity source, per-pass maximum-plus-one bound, entity-level
deduplication, final cap, `blocking-v1`, and the absence of scoring or public
API changes.

- [x] **Step 2: Mark completed plan steps**

Change each executed checkbox in this plan from `[ ]` to `[x]`. Do not
change acceptance criteria to hide an unmet requirement.

- [x] **Step 3: Run the complete verification tree**

```powershell
npm.cmd run prisma:validate
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:integration
npm.cmd run build
docker compose config --quiet
git diff --check
```

Expected: every command exits zero; Jest reports no failed suites or tests.

- [x] **Step 4: Audit the final change set**

```powershell
git status --short --branch
git diff --stat
git diff -- apps/api/src/blocking packages/config tests/integration/day6-blocking.integration.ts
```

Confirm the tree contains only Day 6 implementation, tests, configuration,
specification, plan, and documentation.

- [x] **Step 5: Hand off for user review**

Keep `feature/day6-blocking-v1` uncommitted. Report implemented behavior,
verification counts, known limitations, and detailed manual testing
instructions. Wait for the user to request changes or authorize commit and
push; when authorized, merge and push to `main` as well.
