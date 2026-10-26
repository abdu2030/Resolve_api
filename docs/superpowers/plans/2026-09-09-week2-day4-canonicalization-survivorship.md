# Week 2 Day 4 Canonicalization and Entity Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce deterministic canonical Person and Company data with field provenance and immutable history, then expose tenant-safe entity, linked-record, and history read APIs.

**Architecture:** A pure canonicalization policy converts linked source records into canonical fields and provenance. A transaction-scoped service serializes recomputation with the existing PostgreSQL advisory-lock helper and writes the entity, current provenance, and one history snapshot atomically. A separate entities module provides authenticated, cursor-paginated reads without mutating legacy data.

**Tech Stack:** NestJS, TypeScript, Prisma 7, PostgreSQL, class-validator, Jest, Supertest, Swagger/OpenAPI.

**Spec:** `docs/superpowers/specs/2026-09-09-week2-day4-canonicalization-survivorship-design.md`

## Global Constraints

- Keep the modular monolith; add no services, queues, caches, or dependencies.
- Policy version is exactly `canonicalization-v1`.
- Source priority is an integer `0..1000`; lower is stronger; default is `100`.
- Survivorship order is priority, field-specific completeness, recency, then stable record ID.
- Raw source records and source-record versions remain unchanged.
- `REVIEW` never changes canonical entity state.
- Unchanged replay never adds history unless it is backfilling a legacy version-0 entity.
- Every entity query is tenant-scoped; cross-tenant IDs return the same `404` as missing IDs.
- Read endpoints require `entities:read`.
- Records/history page size defaults to `25` and is bounded to `1..100`.
- Preserve existing `/v1/records` response behavior.
- Do not commit during execution. The user reviews the complete working tree first; later commits are split at the task boundaries below when explicitly requested.

## Planned File Structure

### Database and source contract

- Modify `packages/database/prisma/schema.prisma`: enums, columns, relations, indexes, and constraints represented by Prisma.
- Create `packages/database/prisma/migrations/20260909_week2_day4_canonicalization/migration.sql`: deterministic PostgreSQL migration and check constraints.
- Modify `packages/database/src/index.ts`: export new generated enums under explicit database aliases.
- Modify `packages/contracts/src/api-scope.ts`: add `entities:read`.
- Modify `packages/contracts/src/create-source.dto.ts`: validate optional priority.
- Modify `packages/contracts/test/contracts.spec.ts`: priority and scope contract tests.
- Modify `apps/api/src/sources/source-registration.service.ts`: persist/default priority and reject conflicting replay.
- Modify `apps/api/src/sources/source-response.dto.ts`: return effective priority.
- Modify `apps/api/src/sources/sources.controller.ts`: document priority.
- Modify `tests/integration/day4-api.integration.ts`: preserve Week 1 source behavior while adding priority assertions.
- Create `tests/integration/week2-day4-schema.integration.ts`: migration, index, check, and tenant-FK tests.

### Canonicalization

- Create `apps/api/src/canonicalization/canonicalization.constants.ts`: policy version.
- Create `apps/api/src/canonicalization/canonicalization.types.ts`: pure inputs, selections, projection, and trigger types.
- Create `apps/api/src/canonicalization/canonicalization-data-integrity.error.ts`: invalid stored-state error.
- Create `apps/api/src/canonicalization/canonicalization-policy.ts`: extraction, ranking, canonical object assembly, and provenance shaping.
- Create `apps/api/src/canonicalization/canonicalization-policy.spec.ts`: deterministic unit coverage.
- Create `apps/api/src/canonicalization/canonicalization.service.ts`: tenant-scoped transactional recomputation.
- Create `apps/api/src/canonicalization/canonicalization.module.ts`: export the service.
- Move `apps/api/src/records/canonical-json.ts` to `apps/api/src/common/json/canonical-json.ts`: share deterministic JSON comparison.
- Move `apps/api/src/records/canonical-json.spec.ts` to `apps/api/src/common/json/canonical-json.spec.ts`.
- Modify `apps/api/src/records/record-ingestion.service.ts`: invoke canonicalization after accepted links.
- Modify `apps/api/src/records/records.module.ts`: import canonicalization module.
- Create `tests/integration/week2-day4-canonicalization.integration.ts`: pipeline persistence, idempotency, review, and concurrency.

### Entity read API

- Create `apps/api/src/entities/entity-pagination.dto.ts`: validated query parameters.
- Create `apps/api/src/entities/entity-cursor.ts`: opaque cursor codecs.
- Create `apps/api/src/entities/entity-cursor.spec.ts`: round-trip and rejection tests.
- Create `apps/api/src/entities/entity-data-integrity.error.ts`: invalid stored entity-state error.
- Create `apps/api/src/entities/entity-response.dto.ts`: entity, provenance, record, history, and page DTOs.
- Create `apps/api/src/entities/entity-query.service.ts`: tenant-scoped reads and stable pagination.
- Create `apps/api/src/entities/entities.controller.ts`: three thin authenticated endpoints.
- Create `apps/api/src/entities/entities.module.ts`: module boundary.
- Modify `apps/api/src/app.module.ts`: import entities module.
- Create `tests/integration/week2-day4-entities-api.integration.ts`: endpoint, authorization, isolation, pagination, and OpenAPI tests.

### Documentation

- Modify `docs/contracts/mvp-v1.md`: source priority, canonical fields, endpoint responses, and errors.
- Modify `docs/architecture/overview.md`: canonicalization transaction and survivorship order.
- Modify `README.md`: scopes and reproducible manual checks.

---

### Task 1: Database Schema, Source Priority, and Read Scope

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260909_week2_day4_canonicalization/migration.sql`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/contracts/src/api-scope.ts`
- Modify: `packages/contracts/src/create-source.dto.ts`
- Modify: `packages/contracts/test/contracts.spec.ts`
- Modify: `apps/api/src/sources/source-registration.service.ts`
- Modify: `apps/api/src/sources/source-response.dto.ts`
- Modify: `apps/api/src/sources/sources.controller.ts`
- Modify: `tests/integration/day4-api.integration.ts`
- Create: `tests/integration/week2-day4-schema.integration.ts`

**Interfaces:**

- Consumes: existing tenant-safe composite IDs and source-registration transaction.
- Produces: `CanonicalSelectionRule`, `CanonicalTriggerOperation`, Prisma models `EntityFieldProvenance` and `EntityCanonicalVersion`, `SourceSystem.priority`, `Entity.canonicalVersion`, and contract scope `entities:read`.

- [ ] **Step 1: Add failing DTO and scope tests**

```ts
it('validates the source priority range', async () => {
  await expect(
    validatePayload(CreateSourceDto, { name: 'crm', type: 'api', priority: 0 }),
  ).resolves.toEqual([]);
  await expect(
    validatePayload(CreateSourceDto, { name: 'crm', type: 'api', priority: 1001 }),
  ).resolves.not.toHaveLength(0);
});
```

Run:

```powershell
npm test -- packages/contracts/test/contracts.spec.ts
```

Expected: FAIL because priority is not whitelisted.

- [ ] **Step 2: Implement the public source/scope contract**

Add `@IsOptional() @IsInt() @Min(0) @Max(1000) priority?: number` and append `entities:read` to `API_SCOPES`. Add `priority` to `SourceResponseDto` and the Swagger request schema.

Update source registration to calculate `const priority = input.priority ?? 100`, create with that value, and return it. Preserve the existing type-conflict contract, then reject an effective-priority difference separately:

```ts
if (existing.type !== input.type) {
  throw new ApiException(
    409,
    'SOURCE_TYPE_CONFLICT',
    'A source with this name already exists with a different type',
  );
}
if (existing.priority !== priority) {
  throw new ApiException(
    409,
    'SOURCE_PRIORITY_CONFLICT',
    'A source with this name already exists with a different priority',
  );
}
```

Run the contract test again. Expected: PASS.

- [ ] **Step 3: Add failing migration tests**

Create an isolated-schema integration suite that deploys all migrations and asserts:

```ts
expect(columns).toMatchObject({
  source_priority: { column_default: '100', is_nullable: 'NO' },
  canonical_version: { column_default: '0', is_nullable: 'NO' },
});
expect(tables).toEqual(
  expect.arrayContaining(['entity_field_provenance', 'entity_canonical_versions']),
);
expect(indexes).toEqual(
  expect.arrayContaining([
    'entity_field_provenance_tenant_entity_idx',
    'entity_canonical_versions_tenant_entity_version_idx',
  ]),
);
```

Also attempt invalid priority, duplicate field path, duplicate entity/version, and cross-tenant provenance/history inserts; assert PostgreSQL codes `23514`, `23505`, and `23503` with the named constraints.

Run:

```powershell
npm run test:integration -- --runTestsByPath tests/integration/week2-day4-schema.integration.ts
```

Expected: FAIL because the migration does not exist.

- [ ] **Step 4: Add Prisma models and the SQL migration**

Add Prisma enums:

```prisma
enum CanonicalSelectionRule {
  ONLY_CANDIDATE
  SOURCE_PRIORITY
  COMPLETENESS
  RECENCY
  STABLE_TIE_BREAK
  @@map("canonical_selection_rule")
}

enum CanonicalTriggerOperation {
  ENTITY_CREATED
  RECORD_LINKED
  RECORD_UPDATED
  LEGACY_BACKFILL
  @@map("canonical_trigger_operation")
}
```

Add these Prisma fields and models, plus matching inverse relation arrays on `Tenant`, `SourceSystem`, `SourceRecord`, and `Entity`:

```prisma
model SourceSystem {
  // existing fields stay unchanged
  priority Int @default(100)
  canonicalFieldProvenance EntityFieldProvenance[]
}

model Entity {
  // existing fields stay unchanged
  canonicalVersion  Int @default(0) @map("canonical_version")
  fieldProvenance   EntityFieldProvenance[]
  canonicalVersions EntityCanonicalVersion[]
}

model EntityFieldProvenance {
  id                      String                 @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId                String                 @map("tenant_id") @db.Uuid
  entityId                String                 @map("entity_id") @db.Uuid
  fieldPath               String                 @map("field_path") @db.VarChar(100)
  canonicalValue          Json                   @map("canonical_value")
  rawValue                Json                   @map("raw_value")
  sourceRecordId          String                 @map("source_record_id") @db.Uuid
  sourceSystemId          String                 @map("source_system_id") @db.Uuid
  sourceExternalId        String                 @map("source_external_id") @db.VarChar(255)
  sourcePriority          Int                    @map("source_priority")
  selectionRule           CanonicalSelectionRule @map("selection_rule")
  completenessScore       Int                    @map("completeness_score")
  observedAt              DateTime               @map("observed_at") @db.Timestamptz(3)
  normalizationVersion    String                 @map("normalization_version") @db.VarChar(50)
  canonicalizationVersion String                 @map("canonicalization_version") @db.VarChar(50)
  createdAt               DateTime               @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt               DateTime               @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(3)
  tenant                  Tenant                 @relation(fields: [tenantId], references: [id], onDelete: Restrict, onUpdate: NoAction)
  entity                  Entity                 @relation(fields: [tenantId, entityId], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction)
  sourceRecord            SourceRecord           @relation(fields: [tenantId, sourceRecordId], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction)
  sourceSystem            SourceSystem           @relation(fields: [tenantId, sourceSystemId], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction)

  @@unique([tenantId, entityId, fieldPath], map: "entity_field_provenance_tenant_entity_field_key")
  @@index([tenantId, entityId], map: "entity_field_provenance_tenant_entity_idx")
  @@map("entity_field_provenance")
}

model EntityCanonicalVersion {
  id                      String                    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId                String                    @map("tenant_id") @db.Uuid
  entityId                String                    @map("entity_id") @db.Uuid
  version                 Int
  canonicalData           Json                      @map("canonical_data")
  provenance              Json
  triggerSourceRecordId   String?                   @map("trigger_source_record_id") @db.Uuid
  triggerOperation        CanonicalTriggerOperation @map("trigger_operation")
  canonicalizationVersion String                    @map("canonicalization_version") @db.VarChar(50)
  createdAt               DateTime                  @default(now()) @map("created_at") @db.Timestamptz(3)
  tenant                  Tenant                    @relation(fields: [tenantId], references: [id], onDelete: Restrict, onUpdate: NoAction)
  entity                  Entity                    @relation(fields: [tenantId, entityId], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction)
  triggerSourceRecord     SourceRecord?             @relation(fields: [tenantId, triggerSourceRecordId], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction)

  @@unique([tenantId, entityId, version], map: "entity_canonical_versions_tenant_entity_version_key")
  @@index([tenantId, entityId, version(sort: Desc)], map: "entity_canonical_versions_tenant_entity_version_idx")
  @@map("entity_canonical_versions")
}
```

Give each relation the explicit `map` name used by the migration: `entity_field_provenance_tenant_fkey`, `entity_field_provenance_tenant_entity_fkey`, `entity_field_provenance_tenant_source_record_fkey`, `entity_field_provenance_tenant_source_system_fkey`, `entity_canonical_versions_tenant_fkey`, `entity_canonical_versions_tenant_entity_fkey`, and `entity_canonical_versions_tenant_trigger_record_fkey`.

In SQL, create the enums/tables and these checks:

```sql
ALTER TABLE "source_systems"
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100,
  ADD CONSTRAINT "source_systems_priority_range"
    CHECK ("priority" BETWEEN 0 AND 1000);

ALTER TABLE "entities"
  ADD COLUMN "canonical_version" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "entities_canonical_version_nonnegative"
    CHECK ("canonical_version" >= 0);
```

Name all composite foreign keys exactly as the spec's table ownership describes and add the two access-pattern indexes.

Generate and validate:

```powershell
npm run prisma:generate
npm run prisma:validate
```

Expected: both exit 0.

- [ ] **Step 5: Export generated database enums and run focused tests**

Export the generated enums as `DatabaseCanonicalSelectionRule` and `DatabaseCanonicalTriggerOperation`. Update Week 1 Day 4 source integration expectations for default/explicit priority and configuration conflict.

Run:

```powershell
npm test -- packages/contracts/test/contracts.spec.ts
npm run test:integration -- --runTestsByPath tests/integration/day4-api.integration.ts tests/integration/week2-day4-schema.integration.ts
```

Expected: PASS.

- [ ] **Step 6: Record the future logical commit boundary**

```text
feat(database): add canonical provenance schema and source priority
```

Do not commit until the user approves the complete Day 4 working tree.

---

### Task 2: Pure Canonicalization and Survivorship Policy

**Files:**

- Create: `apps/api/src/canonicalization/canonicalization.constants.ts`
- Create: `apps/api/src/canonicalization/canonicalization.types.ts`
- Create: `apps/api/src/canonicalization/canonicalization-data-integrity.error.ts`
- Create: `apps/api/src/canonicalization/canonicalization-policy.ts`
- Create: `apps/api/src/canonicalization/canonicalization-policy.spec.ts`

**Interfaces:**

- Consumes: contract `EntityType`, raw/normalized plain objects, source metadata, normalization version.
- Produces:
  - `CANONICALIZATION_VERSION = 'canonicalization-v1'`
  - `buildCanonicalProjection(entityType, records): CanonicalProjection`
  - ordered `CanonicalFieldSelection[]` and nested `canonicalData`/`provenance`.

- [ ] **Step 1: Define types and failing priority/format tests**

```ts
export interface CanonicalizationRecord {
  id: string;
  externalId: string;
  updatedAt: Date;
  rawPayload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown>;
  normalizationVersion: string;
  source: { id: string; name: string; priority: number };
}

export interface CanonicalFieldSelection {
  fieldPath: string;
  canonicalValue: string;
  rawValue: string;
  sourceRecordId: string;
  sourceSystemId: string;
  sourceSystemName: string;
  externalId: string;
  sourcePriority: number;
  selectionRule:
    'ONLY_CANDIDATE' | 'SOURCE_PRIORITY' | 'COMPLETENESS' | 'RECENCY' | 'STABLE_TIE_BREAK';
  completenessScore: number;
  observedAt: Date;
  normalizationVersion: string;
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
}

export interface CanonicalProjection {
  canonicalData: Record<string, unknown>;
  provenance: Record<string, unknown>;
  fields: CanonicalFieldSelection[];
}

export type CanonicalTriggerOperation =
  'ENTITY_CREATED' | 'RECORD_LINKED' | 'RECORD_UPDATED' | 'LEGACY_BACKFILL';

export function buildCanonicalProjection(
  entityType: EntityType,
  records: readonly CanonicalizationRecord[],
): CanonicalProjection;
```

First tests must assert that lower priority wins and a display field keeps collapsed raw text while email/phone/domain use normalized values.

Run:

```powershell
npm test -- apps/api/src/canonicalization/canonicalization-policy.spec.ts
```

Expected: FAIL because the policy does not exist.

- [ ] **Step 2: Implement candidate extraction and priority ranking**

Implement explicit Person and Company field descriptors. Use guarded object/string readers; reject malformed normalized objects with a domain data-integrity error rather than `any`. Exclude blank candidates.

Sort by:

```ts
(left, right) =>
  left.sourcePriority - right.sourcePriority ||
  right.completenessScore - left.completenessScore ||
  right.observedAt.getTime() - left.observedAt.getTime() ||
  left.sourceRecordId.localeCompare(right.sourceRecordId);
```

Implement selection-rule derivation by comparing the winner with the runner-up. Run the focused test; expected PASS.

- [ ] **Step 3: Add failing completeness, recency, tie, and address tests**

Cover:

```ts
it.each([
  ['COMPLETENESS', equalPriorityRecordsWithDifferentNameLengths],
  ['RECENCY', equalPriorityAndLengthRecordsWithDifferentDates],
  ['STABLE_TIE_BREAK', fullyTiedRecords],
])('selects by %s', (rule, records) => {
  expect(buildCanonicalProjection(EntityType.Person, records).fields[0]?.selectionRule).toBe(rule);
});
```

Add a case where four address components come from different records and assert their separate provenance paths.

Run the focused suite. Expected: FAIL until all ranking stages and nested assembly are complete.

- [ ] **Step 4: Complete deterministic assembly**

Implement Unicode code-point length with `Array.from(value).length`, normalized full-name completeness for companies, and deterministic field-path ordering. Build nested objects by explicit path mapping, not unchecked dynamic mutation.

Run the focused suite. Expected: PASS.

- [ ] **Step 5: Add edge and input-order tests**

Test Person and Company records with null/missing/empty/whitespace/Unicode fields, registration ID, normalized country, no invented values, and reversed/shuffled record order:

```ts
expect(buildCanonicalProjection(type, records)).toEqual(
  buildCanonicalProjection(type, [...records].reverse()),
);
```

Run:

```powershell
npm test -- apps/api/src/canonicalization/canonicalization-policy.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Record the future logical commit boundary**

```text
feat(canonicalization): add deterministic survivorship policy
```

Do not commit until full Day 4 approval.

---

### Task 3: Transactional Canonicalization in the Resolver Pipeline

**Files:**

- Consume: `apps/api/src/canonicalization/canonicalization-data-integrity.error.ts`
- Create: `apps/api/src/canonicalization/canonicalization.service.ts`
- Create: `apps/api/src/canonicalization/canonicalization.module.ts`
- Move: `apps/api/src/records/canonical-json.ts` to `apps/api/src/common/json/canonical-json.ts`
- Move: `apps/api/src/records/canonical-json.spec.ts` to `apps/api/src/common/json/canonical-json.spec.ts`
- Modify: `apps/api/src/records/record-ingestion.service.ts`
- Modify: `apps/api/src/records/records.module.ts`
- Create: `tests/integration/week2-day4-canonicalization.integration.ts`

**Interfaces:**

- Consumes: `buildCanonicalProjection`, `acquireTransactionLock`, ingestion operation, resolution decision, and a Prisma transaction.
- Produces:

```ts
export interface CanonicalizeLinkedEntityInput {
  tenantId: string;
  entityId: string;
  sourceRecordId: string;
  ingestionOperation: 'CREATED' | 'UPDATED' | 'UNCHANGED';
  resolutionDecision: ResolutionDecision.AutoMatch | ResolutionDecision.NoMatch;
}

canonicalizeLinkedEntity(
  transaction: Prisma.TransactionClient,
  input: CanonicalizeLinkedEntityInput,
): Promise<void>
```

- [ ] **Step 1: Move canonical JSON support into common code**

Move both files without changing behavior. Update `record-ingestion.service.ts` and the moved test import. Run:

```powershell
npm test -- apps/api/src/common/json/canonical-json.spec.ts
```

Expected: PASS with the existing canonical JSON cases.

- [ ] **Step 2: Add the first failing PostgreSQL pipeline tests**

Create the isolated-schema integration suite and ingest through the real HTTP API. First assert that `NO_MATCH` creates entity version 1, provenance, and one snapshot, while `REVIEW` leaves the candidate entity unchanged:

```ts
expect(entity).toMatchObject({
  canonical_version: 1,
  canonical_data: {
    name: 'Abdulkerim Hassen',
    email: 'abdul@example.com',
  },
});
expect(currentProvenance).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      field_path: 'name',
      source_record_id: recordId,
      selection_rule: 'ONLY_CANDIDATE',
      canonicalization_version: 'canonicalization-v1',
    }),
  ]),
);
expect(history).toHaveLength(1);
```

Run:

```powershell
npm run test:integration -- --runTestsByPath tests/integration/week2-day4-canonicalization.integration.ts
```

Expected: FAIL because canonicalization is not connected to ingestion.

- [ ] **Step 3: Implement the transaction service**

Create `CanonicalizationDataIntegrityError extends Error` for impossible missing/malformed linked state. The service must:

```ts
await acquireTransactionLock(transaction, `canonicalization:${input.tenantId}:${input.entityId}`);
```

Then load the entity with `where: { tenantId_id: { tenantId, id: entityId } }`, including only the latest history row. If `UNCHANGED` and version is positive, return before loading records.

Load links using both `tenantId` and `entityId`, selecting each source record's raw payload, normalized payload, normalization version, updated time, external ID, and source ID/name/priority. Reject missing normalized objects or normalization versions.

Derive the trigger:

```ts
function triggerFor(input: CanonicalizeLinkedEntityInput): CanonicalTriggerOperation {
  if (input.ingestionOperation === 'UNCHANGED') return 'LEGACY_BACKFILL';
  if (input.ingestionOperation === 'UPDATED') return 'RECORD_UPDATED';
  return input.resolutionDecision === ResolutionDecision.NoMatch
    ? 'ENTITY_CREATED'
    : 'RECORD_LINKED';
}
```

For version greater than zero, require a latest history row and compare:

```ts
canonicalizeJson({
  canonicalData: entity.canonicalData,
  provenance: latest.provenance,
}) ===
  canonicalizeJson({
    canonicalData: projection.canonicalData,
    provenance: projection.provenance,
  });
```

If equal, return. Otherwise increment the version, update the entity, replace current provenance rows, and insert one immutable snapshot in the same transaction. Map string rules/triggers to the exported database enums.

Run the new integration suite. Expected: it still fails because ingestion has not invoked the service.

- [ ] **Step 4: Wire canonicalization after accepted resolution**
      Export the service from `CanonicalizationModule`; import that module from `RecordsModule`; inject the service into `RecordIngestionService`. After `resolution.resolve`, call it only for `AUTO_MATCH` and `NO_MATCH`, before the idempotency response ledger is written.

Run the integration suite. Expected: the initial `NO_MATCH` and `REVIEW` cases pass.

- [ ] **Step 5: Add the remaining failing PostgreSQL pipeline cases**

Add these independent cases one at a time, watching each fail before completing its path:

- A high-authority record auto-matches an entity and replaces the lower-authority canonical winner.
- A `REVIEW` record creates no provenance/history and does not increment the candidate entity.
- Updating an already linked record recomputes; unchanged replay leaves the version count unchanged.
- A linked version-0 entity receives exactly one `LEGACY_BACKFILL`.
- Concurrent qualifying ingestions produce distinct sequential history versions.
- Canonicalization does not update any raw-payload column; previously stored raw JSON values and immutable versions remain structurally equal.

Run:

```powershell
npm run test:integration -- --runTestsByPath tests/integration/week2-day4-canonicalization.integration.ts
```

Expected: each new case fails for its missing behavior and passes after the minimal correction.

- [ ] **Step 6: Run the canonicalization regression slice**

```powershell
npm test -- apps/api/src/common/json/canonical-json.spec.ts apps/api/src/canonicalization/canonicalization-policy.spec.ts
npm run test:integration -- --runTestsByPath tests/integration/day3-resolver.integration.ts tests/integration/week2-day4-canonicalization.integration.ts
```

Expected: PASS.

- [ ] **Step 7: Record the future logical commit boundary**

```text
feat(api): persist canonical entities with provenance
```

Do not commit until full Day 4 approval.

---

### Task 4: Tenant-Safe Entity Read Endpoints

**Files:**

- Create: `apps/api/src/entities/entity-pagination.dto.ts`
- Create: `apps/api/src/entities/entity-cursor.ts`
- Create: `apps/api/src/entities/entity-cursor.spec.ts`
- Create: `apps/api/src/entities/entity-response.dto.ts`
- Create: `apps/api/src/entities/entity-query.service.ts`
- Create: `apps/api/src/entities/entities.controller.ts`
- Create: `apps/api/src/entities/entities.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `tests/integration/week2-day4-entities-api.integration.ts`

**Interfaces:**

- Consumes: canonical entity/provenance/history tables and existing API-key guards.
- Routes: `GET /v1/entities/:entityId`, `GET /v1/entities/:entityId/records`, and `GET /v1/entities/:entityId/history`.
- Produces:

```ts
getEntity(tenantId: string, entityId: string): Promise<EntityResponseDto>
listRecords(
  tenantId: string,
  entityId: string,
  query: EntityPageQueryDto,
): Promise<LinkedRecordPageDto>
listHistory(
  tenantId: string,
  entityId: string,
  query: EntityPageQueryDto,
): Promise<EntityHistoryPageDto>
```

- [ ] **Step 1: Add failing cursor and query-validation tests**

`EntityPageQueryDto` has optional transformed numeric `limit` with `@IsInt() @Min(1) @Max(100)`, and optional string `cursor`.

Cursor codecs expose:

```ts
encodeRecordCursor({ createdAt: Date, id: string }): string
decodeRecordCursor(value: string): { createdAt: Date; id: string }
encodeHistoryCursor(version: number): string
decodeHistoryCursor(value: string): number
```

Use base64url-encoded JSON with an explicit cursor kind/version. Tests round-trip valid values and reject invalid base64, JSON, cursor kind, timestamp, UUID, and non-positive history version with:

```ts
new ApiException(400, 'INVALID_CURSOR', 'Cursor is invalid');
```

Run:

```powershell
npm test -- apps/api/src/entities/entity-cursor.spec.ts
```

Expected: FAIL because codecs do not exist.

- [ ] **Step 2: Implement bounded opaque cursor support**

Implement strict property/type checks with `unknown` narrowing. Do not accept extra keys. Keep cursor decoding independent of database access.

Run the cursor tests. Expected: PASS.

- [ ] **Step 3: Define exact response DTOs**

Swagger DTOs must model:

```ts
interface EntityResponseDto {
  entity_id: string;
  entity_type: EntityType;
  canonical_data: Record<string, unknown>;
  canonical_version: number;
  canonicalization_version: string | null;
  provenance: Record<string, unknown>;
  record_count: number;
  created_at: string;
  updated_at: string;
}

interface LinkedRecordPageDto {
  items: LinkedRecordResponseDto[];
  next_cursor: string | null;
}

interface EntityHistoryPageDto {
  items: EntityHistoryResponseDto[];
  next_cursor: string | null;
}
```

`LinkedRecordResponseDto` and `EntityHistoryResponseDto` include every field shown in the approved spec. Use nested classes and `@ApiPropertyOptional({ nullable: true })` for nullable values.

- [ ] **Step 4: Add failing API integration tests**

Build the real application against an isolated schema. Seed two tenants and keys with full, missing, invalid, and revoked authorization states. Create enough linked records and history versions for two pages.

Assert:

```ts
await request(server)
  .get(`/v1/entities/${entityId}`)
  .set('Authorization', `Bearer ${entityReadToken}`)
  .expect(200)
  .expect(({ body }) => {
    expect(body).toMatchObject({
      entity_id: entityId,
      canonical_version: 2,
      record_count: 2,
    });
  });
```

Also assert:

- missing/invalid/revoked keys return `401`;
- a key without `entities:read` returns `403`;
- missing and cross-tenant IDs both return `404 ENTITY_NOT_FOUND`;
- malformed UUID, limit, and cursor return `400`;
- record and history pages contain no duplicates and return `next_cursor: null` on the last page;
- linked records include current raw/normalized payload, source priority, and stored link evidence;
- entity provenance is nested by field path;
- a version-0 entity returns null policy version and empty provenance;
- reads never change entity versions or insert history.

Run:

```powershell
npm run test:integration -- --runTestsByPath tests/integration/week2-day4-entities-api.integration.ts
```

Expected: FAIL because routes do not exist.

- [ ] **Step 5: Implement tenant-scoped query service**

Use `findUnique({ where: { tenantId_id: { tenantId, id: entityId } } })` for every entity existence check. Throw:

```ts
new ApiException(404, 'ENTITY_NOT_FOUND', 'Entity does not exist');
```

For record pages, fetch `limit + 1` links ordered by `createdAt DESC, id DESC`. When a record cursor is present, use:

```ts
OR: [
  { createdAt: { lt: cursor.createdAt } },
  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
];
```

For history pages, fetch `limit + 1` with `version: { lt: cursor.version }` ordered by version descending. Derive `next_cursor` from the last returned item only when an extra row exists.

Convert database enum/entity casing to the public contract explicitly. Convert Decimal confidence with `Number(link.score)`. Validate stored JSON as plain objects and throw `EntityDataIntegrityError` for malformed internal state:

```ts
export class EntityDataIntegrityError extends Error {
  constructor() {
    super('Stored entity data is inconsistent');
    this.name = 'EntityDataIntegrityError';
  }
}
```

Run the API integration suite. Expected: endpoint behavior passes after controller wiring.

- [ ] **Step 6: Add thin controller and module**

Implement:

```ts
@Get(':entityId')
@RequireScopes('entities:read')
get(...)

@Get(':entityId/records')
@RequireScopes('entities:read')
listRecords(...)

@Get(':entityId/history')
@RequireScopes('entities:read')
listHistory(...)
```

Use `ParseUUIDPipe({ version: '4' })`, validated query DTOs, bearer auth, and Swagger `200/400/401/403/404` decorators. Import `EntitiesModule` in `AppModule`.

Run the API integration suite. Expected: PASS.

- [ ] **Step 7: Verify the OpenAPI contract**

In the same integration suite, load `/docs-json` and assert all three paths, bearer security, pagination parameters, response schemas, and error responses:

```ts
expect(document.paths).toMatchObject({
  '/v1/entities/{entityId}': { get: expect.any(Object) },
  '/v1/entities/{entityId}/records': { get: expect.any(Object) },
  '/v1/entities/{entityId}/history': { get: expect.any(Object) },
});
```

Run the suite again. Expected: PASS.

- [ ] **Step 8: Record the future logical commit boundary**

```text
feat(api): add tenant-scoped entity read endpoints
```

Do not commit until full Day 4 approval.

---

### Task 5: Documentation and Full Verification

**Files:**

- Modify: `docs/contracts/mvp-v1.md`
- Modify: `docs/architecture/overview.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: completed database, canonicalization, and API behavior.
- Produces: synchronized public documentation and a verified review-ready working tree.

- [ ] **Step 1: Update contract documentation**

Document:

- source `priority`, default/range, and conflict response;
- `entities:read`;
- all three endpoint parameters and response shapes;
- survivorship ordering and `canonicalization-v1`;
- version-0 legacy behavior;
- canonical history and provenance semantics;
- `400/401/403/404/409` errors.

Use the exact field names and examples from the approved spec.

- [ ] **Step 2: Update architecture documentation**

Add the synchronous transaction sequence:

```text
resolution link
  -> entity advisory lock
  -> linked-record projection
  -> deterministic survivorship
  -> entity + current provenance + immutable snapshot
```

State that `REVIEW` does not canonicalize and PostgreSQL remains the durable source of truth.

- [ ] **Step 3: Add reproducible README checks**

Include PowerShell commands for source creation with priority, two matching record ingestions, and the three entity reads. Use environment-variable placeholders such as `$resolveApiKey` and `$entityId`; do not include secrets.

- [ ] **Step 4: Run formatting and static verification**

```powershell
npm run format
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run prisma:validate
```

Expected: every command exits 0. Inspect `git diff` after formatting and keep only Day 4 changes.

- [ ] **Step 5: Run all unit and integration tests**

```powershell
npm test
npm run test:integration
```

Expected: all suites pass with zero failing tests.

- [ ] **Step 6: Perform migration replay verification**

Against a disposable isolated schema:

```powershell
npm run prisma:migrate:deploy
npm run prisma:migrate:deploy
```

Expected: first command applies migrations; second reports no pending migrations.

- [ ] **Step 7: Prepare the user review handoff**

Report:

- exact files changed;
- unit/integration suite and test totals from fresh runs;
- any environment prerequisite;
- detailed manual PowerShell testing from clean stack startup through source creation, ingest, entity reads, idempotent replay, tenant isolation, and database inspection;
- the five proposed logical commit groups.

Leave all changes uncommitted.

- [ ] **Step 8: Record the future documentation commit boundary**

```text
docs: document canonicalization and entity read APIs
```

Do not commit until the user explicitly says to commit and push. At that point, create the five logical commits listed in Tasks 1 through 5, fast-forward `main`, push only `main`, and remove the local feature branch.
