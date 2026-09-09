# Week 2 Day 3 Resolver Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect record ingestion to normalization, blocking, comparison, scoring, decisions, entity linking, entity creation, and review-case creation in one tenant-scoped transaction.

**Architecture:** Add a NestJS `ResolutionService` between record persistence and idempotency-response persistence. It uses the active Prisma transaction for candidate generation and all writes, stores each candidate comparison, applies a pure deterministic candidate-selection policy, then creates either an entity link or a review case.

**Tech Stack:** NestJS 11, TypeScript 5.9, Prisma 7, PostgreSQL, Jest 29, Supertest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-09-week2-day3-resolver-pipeline-design.md`

## Global Constraints

- Preserve source-record raw payloads and immutable raw versions.
- Derive tenant identity from the authenticated API key.
- Keep `normalization-v1`, `blocking-v1`, `features-v1`, and `rules-0.1.0`.
- Use the inclusive `0.72` and `0.92` decision thresholds already implemented by `scoreFeatures`.
- Execute record persistence, resolution side effects, match evidence, and idempotency-response persistence in one transaction.
- Return confidence rounded to four decimal places; rank candidates and decide thresholds with full-precision scores.
- Treat multiple automatic candidates as `REVIEW`.
- Create no canonical field values during Day 3.
- Keep existing `/v1/records` response fields and status codes.
- Leave implementation changes uncommitted until the user reviews them.

---

### Task 1: Resolution contract and deterministic candidate selection

**Files:**

- Modify: `packages/contracts/src/record-ingestion-result.ts`
- Modify: `packages/contracts/src/resolution-result.ts`
- Create: `apps/api/src/resolution/resolution.types.ts`
- Create: `apps/api/src/resolution/candidate-selection.ts`
- Test: `apps/api/src/resolution/candidate-selection.spec.ts`
- Modify: `apps/api/src/records/record-response.dto.ts`

**Interfaces:**

- Produces: `ResolutionOutcome = Omit<ResolutionResult, 'record_id' | 'created_at'>`
- Produces: `RecordIngestionResult extends ResolutionResult`
- Produces: `CandidateScore`, `CandidateSelection`
- Produces: `selectResolutionOutcome(scores): CandidateSelection`

- [ ] **Step 1: Write failing contract and selection tests**

Extend the contracts test to require the resolution fields on a record result.
Create `candidate-selection.spec.ts` with a small factory and these cases:

```ts
import { ResolutionDecision } from '@resolve/contracts';

import { selectResolutionOutcome, type CandidateScore } from './candidate-selection.js';

function candidate(
  entityId: string,
  supportingRecordId: string,
  score: number,
  decision: ResolutionDecision,
): CandidateScore {
  return {
    entityId,
    supportingRecordId,
    matchFeatureId: 'feature-' + supportingRecordId,
    score,
    decision,
    features: { email_exact: score >= 0.92 },
    contradictions: [],
  };
}

it('selects the only automatic candidate', () => {
  const selected = selectResolutionOutcome([
    candidate('entity-b', 'record-b', 0.8, ResolutionDecision.Review),
    candidate('entity-a', 'record-a', 0.95, ResolutionDecision.AutoMatch),
  ]);

  expect(selected).toMatchObject({
    decision: ResolutionDecision.AutoMatch,
    candidateCount: 2,
    selected: { entityId: 'entity-a' },
    additionalContradictions: [],
  });
});

it('sends multiple automatic candidates to review', () => {
  const selected = selectResolutionOutcome([
    candidate('entity-b', 'record-b', 0.96, ResolutionDecision.AutoMatch),
    candidate('entity-a', 'record-a', 0.96, ResolutionDecision.AutoMatch),
  ]);

  expect(selected.decision).toBe(ResolutionDecision.Review);
  expect(selected.selected?.entityId).toBe('entity-a');
  expect(selected.additionalContradictions).toEqual([
    {
      code: 'MULTIPLE_AUTO_MATCH_CANDIDATES',
      message: 'More than one existing entity met the automatic-match threshold.',
      severity: 'blocking',
    },
  ]);
});

it('keeps one best supporting record per candidate entity', () => {
  const selected = selectResolutionOutcome([
    candidate('entity-a', 'record-b', 0.8, ResolutionDecision.Review),
    candidate('entity-a', 'record-a', 0.85, ResolutionDecision.Review),
  ]);

  expect(selected.candidateCount).toBe(1);
  expect(selected.selected?.supportingRecordId).toBe('record-a');
});

it('returns no match with the strongest rejected candidate', () => {
  const selected = selectResolutionOutcome([
    candidate('entity-b', 'record-b', 0.4, ResolutionDecision.NoMatch),
    candidate('entity-a', 'record-a', 0.6, ResolutionDecision.NoMatch),
  ]);

  expect(selected).toMatchObject({
    decision: ResolutionDecision.NoMatch,
    candidateCount: 2,
    selected: { entityId: 'entity-a', score: 0.6 },
  });
});

it('returns no match with no selected candidate for an empty set', () => {
  expect(selectResolutionOutcome([])).toEqual({
    decision: ResolutionDecision.NoMatch,
    candidateCount: 0,
    selected: null,
    additionalContradictions: [],
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
npm.cmd run test -- apps/api/src/resolution/candidate-selection.spec.ts packages/contracts/test/contracts.spec.ts
```

Expected: Jest fails because the resolution selection files and expanded
record contract do not exist.

- [ ] **Step 3: Implement the contract and pure selection policy**

Add to `resolution-result.ts`:

```ts
export type ResolutionOutcome = Omit<ResolutionResult, 'record_id' | 'created_at'>;
```

Make `RecordIngestionResult` extend `ResolutionResult`, retaining the source,
version, status, and operation fields.

Define the selection inputs in `resolution.types.ts`:

```ts
export interface CandidateScore {
  entityId: string;
  supportingRecordId: string;
  matchFeatureId: string;
  score: number;
  decision: ResolutionDecision;
  features: Record<string, boolean | null | number>;
  contradictions: ContradictionEvidence[];
}

export interface CandidateSelection {
  decision: ResolutionDecision;
  candidateCount: number;
  selected: CandidateScore | null;
  additionalContradictions: ContradictionEvidence[];
}
```

Implement `selectResolutionOutcome` by retaining the highest score for each
entity. Break score ties with ascending entity ID, then ascending supporting
record ID. Select one automatic candidate, convert two or more automatic
candidates to review, otherwise select the strongest review candidate, then
the strongest rejected candidate.

- [ ] **Step 4: Expand the Swagger DTO**

Add `entity_id`, `decision`, `confidence`, `matched_against`,
`explanation`, and `algorithm_version` to `RecordResponseDto`.
Use `ApiPropertyOptional` for `matched_against`. Describe the explanation
with these required keys:

```ts
@ApiProperty({
  type: 'object',
  required: ['candidate_count', 'features', 'contradictions'],
  properties: {
    candidate_count: { type: 'integer', minimum: 0 },
    features: { type: 'object', additionalProperties: true },
    contradictions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'message', 'severity'],
        properties: {
          code: { type: 'string' },
          field: { type: 'string' },
          message: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'warning'] },
        },
      },
    },
  },
})
explanation!: ResolutionExplanation;
```

- [ ] **Step 5: Verify Task 1**

Run:

```powershell
npm.cmd run test -- apps/api/src/resolution/candidate-selection.spec.ts packages/contracts/test/contracts.spec.ts
npm.cmd run typecheck -w @resolve/api
```

Expected: focused tests and API type checking pass.

---

### Task 2: Review-case schema and stored link explanations

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260909170000_week2_day3_resolver_pipeline/migration.sql`
- Test: `tests/integration/day3-resolver-schema.integration.ts`

**Interfaces:**

- Produces: `ReviewCaseStatus.OPEN | RESOLVED`
- Produces: tenant-scoped `ReviewCase` Prisma model
- Adds: required `EntityRecordLink.explanation: Json`
- Adds: composite identity on each selected `MatchFeature`

- [ ] **Step 1: Write the failing schema integration test**

Create an isolated schema, apply migrations through the Prisma CLI, and assert:

```ts
const reviewColumns = await database.query<{ column_name: string; is_nullable: string }>(
  `SELECT column_name, is_nullable
     FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'review_cases'
    ORDER BY column_name`,
  [schemaName],
);
expect(reviewColumns.rows).toEqual(
  expect.arrayContaining([
    { column_name: 'algorithm_version', is_nullable: 'NO' },
    { column_name: 'candidate_entity_id', is_nullable: 'NO' },
    { column_name: 'candidate_source_record_id', is_nullable: 'NO' },
    { column_name: 'explanation', is_nullable: 'NO' },
    { column_name: 'match_feature_id', is_nullable: 'NO' },
    { column_name: 'score', is_nullable: 'NO' },
    { column_name: 'source_record_id', is_nullable: 'NO' },
    { column_name: 'status', is_nullable: 'NO' },
    { column_name: 'tenant_id', is_nullable: 'NO' },
  ]),
);
```

Seed two tenants plus their records, entities, and match features. Attempt a
review row that mixes tenant A with tenant B's candidate entity and assert a
foreign-key rejection. Insert a valid review row, then attempt a second row for
the same tenant and source record and assert the uniqueness rejection. Query
`entity_record_links.explanation` to confirm the migration backfills existing
links with:

```json
{ "candidate_count": 0, "features": {}, "contradictions": [] }
```

- [ ] **Step 2: Run the schema test and confirm RED**

Run:

```powershell
npm.cmd run test:integration -- tests/integration/day3-resolver-schema.integration.ts
```

Expected: the test fails because `review_cases` and the link explanation
column do not exist.

- [ ] **Step 3: Add the Prisma models and migration**

Add:

```prisma
enum ReviewCaseStatus {
  OPEN
  RESOLVED

  @@map("review_case_status")
}
```

Add `explanation Json` to `EntityRecordLink`. Add a `ReviewCase` model
and named relations for the source and candidate source records:

```prisma
model ReviewCase {
  id                      String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId                String           @map("tenant_id") @db.Uuid
  sourceRecordId          String           @map("source_record_id") @db.Uuid
  candidateEntityId       String           @map("candidate_entity_id") @db.Uuid
  candidateSourceRecordId String           @map("candidate_source_record_id") @db.Uuid
  matchFeatureId          String           @map("match_feature_id") @db.Uuid
  status                  ReviewCaseStatus @default(OPEN)
  score                   Decimal          @db.Decimal(5, 4)
  explanation             Json
  algorithmVersion        String           @map("algorithm_version") @db.VarChar(50)
  createdAt               DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt               DateTime         @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(3)
  tenant                  Tenant           @relation(fields: [tenantId], references: [id], onDelete: Restrict, onUpdate: NoAction, map: "review_cases_tenant_fkey")
  sourceRecord            SourceRecord     @relation("ReviewCaseSourceRecord", fields: [tenantId, sourceRecordId], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction, map: "review_cases_tenant_source_record_fkey")
  candidateSourceRecord   SourceRecord     @relation("ReviewCaseCandidateRecord", fields: [tenantId, candidateSourceRecordId], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction, map: "review_cases_tenant_candidate_record_fkey")
  candidateEntity         Entity           @relation(fields: [tenantId, candidateEntityId], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction, map: "review_cases_tenant_candidate_entity_fkey")
  matchFeature            MatchFeature     @relation(fields: [tenantId, matchFeatureId, sourceRecordId, candidateSourceRecordId, candidateEntityId], references: [tenantId, id, sourceRecordId, candidateSourceRecordId, candidateEntityId], onDelete: Restrict, onUpdate: NoAction, map: "review_cases_selected_match_feature_fkey")

  @@unique([tenantId, sourceRecordId], map: "review_cases_tenant_source_record_key")
  @@index([tenantId, status, createdAt], map: "review_cases_tenant_status_created_idx")
  @@index([tenantId, candidateEntityId], map: "review_cases_tenant_candidate_entity_idx")
  @@map("review_cases")
}
```

Add a composite unique key to `MatchFeature` over tenant, ID, source record,
candidate source record, and candidate entity. Point the review case's
five-column relation at that key so PostgreSQL proves that the selected
evidence belongs to the same source and candidate.

The migration must:

```sql
CREATE TYPE "review_case_status" AS ENUM ('OPEN', 'RESOLVED');

ALTER TABLE "entity_record_links" ADD COLUMN "explanation" JSONB;
UPDATE "entity_record_links"
SET "explanation" =
  '{"candidate_count":0,"features":{},"contradictions":[]}'::jsonb;
ALTER TABLE "entity_record_links" ALTER COLUMN "explanation" SET NOT NULL;

ALTER TABLE "match_features"
ADD CONSTRAINT "match_features_review_identity_key"
UNIQUE (
  "tenant_id", "id", "source_record_id",
  "candidate_source_record_id", "candidate_entity_id"
);
```

Create `review_cases` with a named score check from zero through one, the
tenant/source uniqueness constraint, and these composite tenant-safe foreign
keys:

```sql
ALTER TABLE "review_cases"
ADD CONSTRAINT "review_cases_tenant_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT;

ALTER TABLE "review_cases"
ADD CONSTRAINT "review_cases_tenant_source_record_fkey"
FOREIGN KEY ("tenant_id", "source_record_id")
REFERENCES "source_records"("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE "review_cases"
ADD CONSTRAINT "review_cases_tenant_candidate_record_fkey"
FOREIGN KEY ("tenant_id", "candidate_source_record_id")
REFERENCES "source_records"("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE "review_cases"
ADD CONSTRAINT "review_cases_tenant_candidate_entity_fkey"
FOREIGN KEY ("tenant_id", "candidate_entity_id")
REFERENCES "entities"("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE "review_cases"
ADD CONSTRAINT "review_cases_selected_match_feature_fkey"
FOREIGN KEY (
  "tenant_id", "match_feature_id", "source_record_id",
  "candidate_source_record_id", "candidate_entity_id"
)
REFERENCES "match_features" (
  "tenant_id", "id", "source_record_id",
  "candidate_source_record_id", "candidate_entity_id"
) ON DELETE RESTRICT;
```

- [ ] **Step 4: Generate Prisma and verify Task 2**

Run:

```powershell
npm.cmd run prisma:validate
npm.cmd run prisma:generate
npm.cmd run test:integration -- tests/integration/day3-resolver-schema.integration.ts
```

Expected: Prisma validates and generates, and the schema integration test
passes.

---

### Task 3: Transaction-aware blocking and resolver orchestration

**Files:**

- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Modify: `apps/api/src/blocking/candidate-generation.service.ts`
- Create: `apps/api/src/resolution/resolution-data-integrity.error.ts`
- Create: `apps/api/src/resolution/resolution.service.ts`
- Create: `apps/api/src/resolution/resolution.module.ts`
- Modify: `apps/api/src/records/records.module.ts`
- Test: `tests/integration/day3-resolver.integration.ts`

**Interfaces:**

- Changes: `findCandidates(tenantId, sourceRecordId, client?)`
- Produces: `ResolutionService.resolve(transaction, tenantId, sourceRecordId)`
- Produces: `ResolutionModule`

- [ ] **Step 1: Add the API matching dependency**

Add `"@resolve/matching": "^0.1.0"` to the API workspace dependencies and run:

```powershell
npm.cmd install --package-lock-only
```

- [ ] **Step 2: Write failing resolver integration tests**

Build `day3-resolver.integration.ts` with the established isolated-schema
setup. Resolve source records by calling `ResolutionService` inside
`databaseClient.$transaction`.

Seed one incoming Person record and no candidates, then assert:

```ts
expect(outcome).toMatchObject({
  decision: 'NO_MATCH',
  confidence: 0,
  algorithm_version: 'rules-0.1.0',
  explanation: {
    candidate_count: 0,
    features: {},
    contradictions: [],
  },
});
expect(await prisma.entity.count({ where: { tenantId } })).toBe(1);
expect(await prisma.entityRecordLink.count({ where: { tenantId } })).toBe(1);
```

Seed a linked supporting record with the same normalized email and phone as a
new incoming record. Assert `AUTO_MATCH`, the existing entity ID, one new
link, and a persisted `match_features` row.

Seed a name-and-location candidate with a conflicting phone. Assert `REVIEW`,
confidence between `0.72` and `0.92`, one open review case, and no incoming
record link.

Seed two linked entities with the same exact email as the incoming record.
Assert `REVIEW` and the
`MULTIPLE_AUTO_MATCH_CANDIDATES` blocking contradiction.

- [ ] **Step 3: Run the resolver test and confirm RED**

Run:

```powershell
npm.cmd run test:integration -- tests/integration/day3-resolver.integration.ts
```

Expected: TypeScript or Jest fails because `ResolutionService` does not
exist.

- [ ] **Step 4: Make candidate generation transaction-aware**

Define:

```ts
type CandidateQueryClient = Pick<Prisma.TransactionClient, 'sourceRecord' | '$queryRaw'>;
```

Change `findCandidates` to accept
`client: CandidateQueryClient = this.prisma`, and use `client` for the
source-record lookup and each raw blocking query. Run the existing Day 6
blocking integration suite to confirm unchanged behavior.

- [ ] **Step 5: Implement resolution orchestration**

`ResolutionService.resolve` must first query
`entityRecordLink.findUnique({ where: { tenantId_sourceRecordId } })` and
`reviewCase.findUnique({ where: { tenantId_sourceRecordId } })`. Convert an
existing row into a stored response without writing evidence.

For a new decision:

```ts
const blocking = await this.candidates.findCandidates(tenantId, sourceRecordId, transaction);
const incoming = await loadComparisonRecord(transaction, tenantId, sourceRecordId);
const comparisons = await compareAndPersist(transaction, tenantId, incoming, blocking.candidates);
const selection = selectResolutionOutcome(comparisons);
```

`compareAndPersist` loads supporting records with `tenantId` and an ID
`in` filter. For each supporting record, call `extractFeatures`, then
`scoreFeatures`, then create a `matchFeature` row. Map database entity types
to contract entity types before extraction.

Build the public explanation from the selected candidate:

```ts
const explanation: ResolutionExplanation = {
  candidate_count: selection.candidateCount,
  features: selection.selected?.features ?? {},
  contradictions: [
    ...(selection.selected?.contradictions ?? []),
    ...selection.additionalContradictions,
  ],
};
const confidence = roundForPersistence(selection.selected?.score ?? 0);
```

For `AUTO_MATCH`, create an entity-record link to the selected entity. For
`REVIEW`, create a review case with the selected match-feature ID. For
`NO_MATCH`, create an entity with `canonicalData: {}`, then create its link.
Set `matched_against` only for automatic and review outcomes.

Throw `ResolutionDataIntegrityError` when the incoming record or any
supporting record is unavailable. Its message must not contain identifiers or
payload fields.

- [ ] **Step 6: Add module wiring and verify Task 3**

`ResolutionModule` imports `BlockingModule`, provides and exports
`ResolutionService`. `RecordsModule` imports `ResolutionModule`.

Run:

```powershell
npm.cmd run test -- apps/api/src/resolution/candidate-selection.spec.ts
npm.cmd run test:integration -- tests/integration/day3-resolver.integration.ts tests/integration/day6-blocking.integration.ts
npm.cmd run typecheck -w @resolve/api
```

Expected: selection unit tests, resolver integration tests, existing blocking
tests, and API type checking pass.

---

### Task 4: Connect ingestion and preserve replay behavior

**Files:**

- Modify: `apps/api/src/records/record-ingestion.service.ts`
- Modify: `apps/api/src/records/record-response.dto.ts`
- Modify: `tests/integration/day4-api.integration.ts`
- Modify: `tests/integration/day5-normalization.integration.ts`
- Modify: `tests/integration/day7-checkpoint.integration.ts`
- Modify: `apps/api/test/openapi.e2e-spec.ts`
- Test: `tests/integration/day3-resolver-api.integration.ts`

**Interfaces:**

- Changes: `POST /v1/records` returns `RecordIngestionResult` with resolution
- Preserves: existing HTTP status, raw history, normalization, and replay rules

- [ ] **Step 1: Write failing API pipeline tests**

Post one record with no candidate and assert:

```ts
expect(body).toMatchObject({
  record_id: expect.any(String),
  entity_id: expect.any(String),
  decision: 'NO_MATCH',
  confidence: 0,
  explanation: {
    candidate_count: 0,
    features: {},
    contradictions: [],
  },
  algorithm_version: 'rules-0.1.0',
  status: 'STORED',
  operation: 'CREATED',
});
expect(body).not.toHaveProperty('matched_against');
```

Post a second source record with exact email and phone and assert automatic
linking to the first response's `entity_id`. Post a review-shaped record and
assert the review response. Query `match_features`, `entity_record_links`,
and `review_cases` to confirm the database state matches each response.

Repeat the same request without an idempotency key and assert that entity,
link, review, and feature counts do not increase. Repeat a separate request
with an idempotency key and assert byte-equivalent JSON plus
`Idempotency-Replayed: true`.

- [ ] **Step 2: Run the API test and confirm RED**

Run:

```powershell
npm.cmd run test:integration -- tests/integration/day3-resolver-api.integration.ts
```

Expected: the response lacks the Day 3 resolution fields.

- [ ] **Step 3: Invoke the resolver inside ingestion**

Inject `ResolutionService` into `RecordIngestionService`. Keep
`upsertRecord` responsible for persistence metadata. After upsert:

```ts
const persistence = await upsertRecord(
  transaction,
  tenantId,
  source.id,
  input,
  rawData,
  payloadHash,
);
const resolution = await this.resolution.resolve(transaction, tenantId, persistence.body.record_id);
const execution: RecordIngestionExecution = {
  ...persistence,
  body: { ...persistence.body, ...resolution },
};
```

Store this combined body in `idempotency_requests.response_body`. Keep the
early replay return so a valid replay skips record and resolver writes.

- [ ] **Step 4: Prove transaction rollback**

In the API integration suite, obtain `ResolutionService` from the Nest
application and use `jest.spyOn(service, 'resolve').mockRejectedValueOnce(new
Error('forced resolver failure'))`. Post a unique source record, expect HTTP
500, then assert that the source record, source-record version, entity, link,
match feature, and review case for that external ID do not exist.

- [ ] **Step 5: Update earlier integration expectations**

Extend the Day 4 response test interface with the six resolution fields. Keep
the exact idempotency-replay equality assertion.

Day 5 normalization assertions continue to inspect raw and normalized storage.
Add resolution-field checks without changing their normalization expectations.

Update the Day 7 checkpoint to use the entity ID created by the first CRM
ingestion instead of inserting a second link for that record. Assert billing
and CSV ingestion automatically select the CRM entity. Keep its direct
candidate-generation and tenant-isolation checks, adjusting the CRM candidate
expectation because billing and CSV now link during ingestion.

- [ ] **Step 6: Verify OpenAPI**

Assert the `RecordResponseDto` schema contains:

```ts
expect(document.components.schemas.RecordResponseDto.required).toEqual(
  expect.arrayContaining([
    'record_id',
    'entity_id',
    'decision',
    'confidence',
    'explanation',
    'algorithm_version',
  ]),
);
```

Assert `matched_against` is optional and decisions enumerate
`AUTO_MATCH`, `REVIEW`, and `NO_MATCH`.

- [ ] **Step 7: Verify Task 4**

Run:

```powershell
npm.cmd run test -- apps/api/test/openapi.e2e-spec.ts
npm.cmd run test:integration -- tests/integration/day3-resolver-api.integration.ts tests/integration/day4-api.integration.ts tests/integration/day5-normalization.integration.ts tests/integration/day7-checkpoint.integration.ts
```

Expected: the new API suite and all affected earlier suites pass.

---

### Task 5: Documentation and complete verification

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/contracts/mvp-v1.md`
- Modify: `docs/superpowers/plans/2026-09-09-week2-day3-resolver-pipeline.md`

**Interfaces:**

- Documents: the live resolver pipeline, response, side effects, replay rule,
  and review-case boundary

- [x] **Step 1: Update documentation**

Update the milestone to Week 2 Day 3. Document the transactional
`ResolutionService`, multiple-automatic-candidate review rule, confidence
rounding, and the three persistence outcomes. Replace statements that scoring
is not wired to ingestion. Add a PowerShell testing example that ingests a
first record and a matching record, then inspects their decisions and entity
IDs.

- [x] **Step 2: Format changed files**

Run Prettier on the expected Day 3 paths:

```powershell
npx.cmd prettier --write apps/api/package.json apps/api/src/blocking/candidate-generation.service.ts apps/api/src/records/record-ingestion.service.ts apps/api/src/records/record-response.dto.ts apps/api/src/records/records.module.ts apps/api/src/resolution apps/api/test/openapi.e2e-spec.ts packages/contracts/src/record-ingestion-result.ts packages/contracts/src/resolution-result.ts packages/contracts/test/contracts.spec.ts packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260909170000_week2_day3_resolver_pipeline/migration.sql tests/integration/day3-resolver-schema.integration.ts tests/integration/day3-resolver.integration.ts tests/integration/day3-resolver-api.integration.ts tests/integration/day4-api.integration.ts tests/integration/day5-normalization.integration.ts tests/integration/day7-checkpoint.integration.ts README.md docs/architecture/overview.md docs/contracts/mvp-v1.md docs/superpowers/specs/2026-09-09-week2-day3-resolver-pipeline-design.md docs/superpowers/plans/2026-09-09-week2-day3-resolver-pipeline.md
```

Review the resulting diff and retain no unrelated formatting changes.

- [x] **Step 3: Run complete verification**

Run each command and require exit code zero:

```powershell
npm.cmd run prisma:validate
npm.cmd run prisma:generate
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test
npm.cmd run test:integration
npm.cmd run build
git diff --check
```

Record exact unit and integration suite and test counts for the review handoff.
Skip a Docker rebuild because Day 3 changes no Dockerfile, dependency manifest
copy list, or external package installation.

- [x] **Step 4: Inspect final scope**

Run:

```powershell
git status --short --branch
git diff --stat
git diff -- packages/contracts apps/api/src/resolution apps/api/src/records apps/api/src/blocking packages/database tests/integration README.md docs
```

Confirm the diff contains no canonical survivorship, review-decision endpoint,
merge, split, worker, queue, webhook, or notification implementation.

- [x] **Step 5: Review checkpoint and later commit grouping**

Leave all changes uncommitted. After the user requests commit and push, create
these logical commits:

```text
feat(contracts): expose record resolution outcomes
feat(database): add resolver decision persistence
feat(api): wire the transactional resolver pipeline
test: cover end-to-end resolver decisions
docs: document the live resolver pipeline
```

Fast-forward the approved commits into `main`, verify `main`, push only
`main`, and remove the local Day 3 branch.
