# Week 2 Day 5 Merge and Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add auditable, tenant-safe manual merge, selected-record split, and explicit merge reversal while preserving source truth and stable entity IDs.

**Architecture:** Add retained entity lifecycle and append-only operation records. Coordinate ingestion shared locks with exclusive manual membership changes, reuse canonicalization in the same transaction, and extend existing entity history with operation metadata. Reuse the idempotency ledger and current authentication boundary.

**Tech Stack:** NestJS, TypeScript, Prisma, PostgreSQL advisory locks, class-validator/transformer, Jest and Supertest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-week2-day5-merge-split-design.md`

## Global Constraints

- No commits or pushes during execution. User reviews the completed working tree first.
- Preserve all raw records, raw versions, original link evidence/IDs, match features, review cases, historical snapshots, and operation events.
- Operation policy is `entity-operations-v1`; canonical projection policy remains `canonicalization-v1` with unchanged extraction/ranking.
- `ENTITY_OPERATION_MAX_RECORDS = 1000`; bound membership reads to 1001 rows and reject oversized operations with 422.
- All queries/FKs/actor references are tenant-safe. Foreign IDs return indistinguishable 404 responses.
- Require `entities:merge` or `entities:split` and a valid Idempotency-Key on their respective POST routes.
- Shared/exclusive tenant gate identity is exactly `entity-membership:${tenantId}`; lock order is idempotency -> membership gate -> record locks -> sorted canonicalization entity locks.
- Both affected entities receive exactly one MERGE/SPLIT canonical snapshot per successful action; no ingestion replay history churn.
- No hard deletes, snapshot rollback, matching/threshold changes, extra worker, cache, or dependency.
- Keep ACTIVE source membership nonempty on split/reversal. Exact reversal restores the original source entity ID and uses current source values.
- Preserve existing entity read contracts additively and keep snake_case public provenance/history metadata.

## Review Focus

1. Ingestion overlapping a link move must resolve/recompute current membership without deadlocks; Task 3 proves ordering with real PostgreSQL barriers.
2. Reordered or differently cased UUID sets must not cause duplicate actions/self-merge bypass; Tasks 1 and 3 cover normalization and semantic replay.
3. Reversal after unrelated ingestion succeeds, but moved-away members or a subsequently merged target reject atomically; Task 3 covers both.
4. An exception during second-entity canonicalization must roll back event/link/lifecycle/entity/idempotency writes; Task 3 injects only the failure while using real persistence.
5. History must expose event-time actor/reason/membership and existing snapshot provenance, including after reversal; Tasks 2 and 3 assert exact public audit metadata.

## Interfaces and File Boundaries

Requests/types live in contracts; Swagger response DTOs remain in the API. Keep membership validation pure in `entity-operation-policy.ts`, database row-to-public operation mapping in `entity-operation.mapper.ts`, and transaction orchestration in `entity-management.service.ts`. Do not grow the existing read service with mutation logic.

```ts
// packages/contracts/src/entity-operation-result.ts
export const ENTITY_OPERATIONS_VERSION = 'entity-operations-v1';
export interface EntityOperationResult {
  operation_id: string;
  operation: 'MERGE' | 'SPLIT' | 'UNMERGE';
  operation_version: typeof ENTITY_OPERATIONS_VERSION;
  source_entity_id: string;
  target_entity_id: string;
  record_ids: string[];
  reason: string;
  actor_api_key_id: string;
  source_version_before: number;
  source_version_after: number;
  target_version_before: number;
  target_version_after: number;
  reversed_operation_id: string | null;
  created_at: string;
}

// canonicalization.service.ts; retain canonicalizeLinkedEntity unchanged externally
recomputeAfterEntityOperation(
  transaction: Prisma.TransactionClient,
  input: {
    tenantId: string;
    entityId: string;
    entityOperationId: string;
    operation: 'MERGE' | 'SPLIT';
  },
): Promise<void>;

// common/database/entity-membership-lock.ts
acquireEntityMembershipLock(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  mode: 'shared' | 'exclusive',
): Promise<void>;

// entity-management.service.ts
interface EntityOperationExecution {
  body: EntityOperationResult;
  httpStatus: 200 | 201;
  replayed: boolean;
}
merge(principal: AuthPrincipal, targetEntityId: string,
  input: MergeEntityDto, key: string): Promise<EntityOperationExecution>;
split(principal: AuthPrincipal, sourceEntityId: string,
  input: SplitEntityDto, key: string): Promise<EntityOperationExecution>;
```

## Task 1: Lifecycle, Audit Schema, and Validated Contracts

**Files:** Modify `packages/database/prisma/schema.prisma`, `packages/database/src/index.ts`, `packages/contracts/src/api-scope.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/resolution-result.ts`, `apps/api/src/auth/bootstrap-api-key.spec.ts`, `tests/integration/foundational-schema.integration.ts`. Create `packages/database/prisma/migrations/20261026_week2_day5_entity_operations/migration.sql`, `packages/contracts/src/entity-operation.dto.ts`, `packages/contracts/src/entity-operation-result.ts`, `packages/contracts/test/entity-operations.spec.ts`, `tests/integration/week2-day5-schema.integration.ts`.

**Produces:** `DatabaseEntityStatus` (ACTIVE/MERGED), `DatabaseEntityOperationType` (MERGE/SPLIT/UNMERGE), extended `DatabaseCanonicalTriggerOperation` (MERGE/SPLIT), Prisma `EntityOperation`/relations, `MergeEntityDto`, `SplitEntityDto`, and `EntityOperationResult` above. Add optional `entity_operation_id?: string` to ResolutionResult/Outcome. Add scopes without altering explicit scope-subset behavior.

- [ ] Write contract tests for valid merge and both split forms; reject both/neither selector, null selectors, malformed IDs, duplicate case variants, empty/full-size-over-limit arrays, invalid/blank reasons, string/fractional/negative/overflow versions, unknown fields. Assert valid UUIDs normalize lowercase and reasons trim. Run focused tests and capture the actual missing-behavior RED.
- [ ] Implement DTOs using existing validator/transformer patterns. A custom property constraint may enforce exclusive split selection (including absent/null cases); do not combine IsOptional/ValidateIf in a way that skips exclusivity. Record arrays cap at 1000 and are unique after lowercase normalization. Export DTOs/result types. Update the bootstrap default-scope test to all five scopes, preserving explicit-subset tests.
- [ ] Add real isolated-schema upgrade tests: deploy pre-Day-5 migrations, seed an existing active entity/link/canonical snapshot, then apply Day 5 and verify unchanged existing data/default ACTIVE/null references. Verify checks, tenant-safe FKs (including actor and reverse event), event-reversal uniqueness, allowed trigger enums, and valid event/link/history references. Capture RED, then add the schema/migration.
- [ ] `EntityOperation` Prisma columns: `id`, `tenantId`, `type`, `operationVersion` default `entity-operations-v1`, `sourceEntityId`, `targetEntityId`, `recordIds` JSON, `reason`, `actorApiKeyId`, `sourceVersionBefore`, `sourceVersionAfter`, `targetVersionBefore`, `targetVersionAfter`, `reversedOperationId?`, `createdAt`. IDs UUID; timestamps Timestamptz(3); reason varchar(500), version varchar(50); version counters Int. Unique tenant/id and tenant/reversedOperationId; Restrict/NoAction tenant-safe FKs. Add ApiKey tenant/id unique key. Add entity lifecycle/self-FK and nullable link/snapshot event FKs. Use explicit named checks for lifecycle consistency, non-self operation, record array/count, nonnegative counters, and UNMERGE/reverse-reference consistency. No blind indexes.
- [ ] Generate/validate Prisma and run focused contracts/schema integration. Update the exact foundational enum expectation for the two new enum types; preserve existing integrity assertions.
- [ ] Report actual RED/GREEN/static evidence. Future commit group: `feat(database): add entity lifecycle and operation audit schema`; do not commit.

## Task 2: Shared Coordination, Structural Canonicalization, and Read Metadata

**Files:** Create `apps/api/src/common/database/entity-membership-lock.ts`, `apps/api/src/entities/entity-operation-response.dto.ts`, `apps/api/src/entities/entity-operation.mapper.ts`, `tests/integration/week2-day5-coordination.integration.ts`. Modify `apps/api/src/records/record-ingestion.service.ts`, `apps/api/src/resolution/resolution.service.ts`, `apps/api/src/records/record-response.dto.ts`, `apps/api/src/blocking/blocking.queries.ts`, `apps/api/src/canonicalization/canonicalization.service.ts`, `apps/api/src/canonicalization/canonicalization.types.ts`, `apps/api/src/entities/entity-query.service.ts`, `apps/api/src/entities/entity-response.dto.ts`; adjust directly affected old API/OpenAPI tests if their exact additive shapes require it.

**Consumes:** Task 1 models/enums/result interface. **Produces:** the two service/helper signatures above and reusable `mapEntityOperation(row): EntityOperationResult` in the mapper. Mapper validates bounded UUID record IDs and stored values; no camelCase leaks. `EntityOperationResponseDto implements EntityOperationResult` provides Swagger for mutations and history.

- [ ] Add real PostgreSQL tests showing simultaneous shared gate holders, exclusive writer blocked until shared holders release, and another tenant unblocked. No sleeps as synchronization; use bounded observed barriers/try-lock queries. Capture RED, implement the shared/exclusive helper with the exact identity, and preserve `acquireTransactionLock`'s existing exclusive semantics.
- [ ] Acquire shared gate in ingestion after successful idempotency replay checks but before source writes, and at ResolutionService entry for independently invoked resolution. Preserve idempotency -> gate -> record -> canonical lock order. Emit optional current `entity_operation_id` only for moved stored links; do not rewrite original matching evidence or historical idempotency responses.
- [ ] Add direct-service real PostgreSQL tests for structural recomputation, empty merged shell, forced equal-projection snapshots, operation IDs, and original ingestion no-op behavior. Capture RED. Refactor canonicalization into shared projection/persistence internals while preserving its existing public ingestion method. Structural method permits empty memberships, uses null source-record trigger, attaches event ID, and always increments/appends once. Maintain existing history-integrity checks and transaction locks.
- [ ] Add ACTIVE filter to candidate SQL without changing blocking signal predicates/bounds/versions. Prove a deliberately invalid merged candidate cannot be selected while valid ACTIVE candidates remain indexed and bounded.
- [ ] Extend GET entity status/merged target; link DTO nullable `entity_operation_id`; history trigger nullable event ID and item nullable `entity_operation`. Load operation metadata with tenant context and use the common mapper. Keep existing RepeatableRead entity reads and provenance mapper. Existing ingestion snapshots return null audit metadata.
- [ ] Run focused coordination, existing Day 4 canonicalization/API, resolver, and blocking regression slices, API typecheck and touched lint. Report. Future group: `feat(entities): coordinate membership and canonical history`; no commit.

## Task 3: Transactional Merge, Split, and Reversal API

**Files:** Create `apps/api/src/entities/entity-operation-policy.ts`, `apps/api/src/entities/entity-operation-policy.spec.ts`, `apps/api/src/entities/entity-management.service.ts`, `apps/api/src/entities/entity-management.controller.ts`, `tests/integration/week2-day5-entity-operations.integration.ts`. Modify `apps/api/src/entities/entities.module.ts` to register controller/service and import `CanonicalizationModule`.

**Consumes:** Task 1 DTOs/models, Task 2 gate/canonical recompute/operation mapper. **Produces:** EntityManagementService `merge`/`split` signatures above and two POST endpoints. Keep pure ownership/subset/version/state validation in policy helpers; transaction/queries in the application service. Avoid duplicating whole transaction or audit-write blocks between the three action modes. Split out a narrowly named persistence file only if the service cannot stay readable.

- [ ] Write focused pure policy tests for active/type/self/version checks, proper split subsets, UUID-case normalization, version exhaustion (409 before overflow), and bounded counts. Implement the smallest guards; all domain errors use the spec's stable codes/ApiException.
- [ ] Add isolated-schema real HTTP tests for two distinct Person entities -> merge -> merged-shell and surviving canonical/read/history state. Record original raw rows/versions, link IDs/evidence, and canonical history, then assert preservation. Initially routes must fail RED. Implement controller guards/UUID parsing, required-key validation, response status/replay header, and explicit Swagger errors.
- [ ] Implement common transaction runner: idempotency lock and semantic request hash; replay/check existing ledger; exclusive tenant gate; bounded tenant entity/membership loads; sorted canonical locks; validated mutation plan; new target creation if split; immutable event insertion with actor from principal and computed before/after versions; tenant-scoped bulk link moves and lifecycle updates; canonicalize both; insert ledger; return mapped event. Check updated link count equals intended count. Enforce combined merge/source split limits before loading projection records. Never mutate raw, historical evidence, or review rows.
- [ ] Add selected-record split and merge-event reversal tests including same original source ID, latest raw updates, unrelated target ingestion, nested provenance, events/versions, and history's event-time actor/reason/record list. Extend the service only for missing behavior. Include Company operations.
- [ ] Cover 401/403/404 denials, wrong-mode/scoped keys, foreign entity/event/record/actor boundaries, self merge (case variants), type mismatch, stale/merged/empty state, missing/invalid key, array/mode validation, atomic membership conflicts, and 1001-record bounded rejection. Require UUID set reordering to replay with the same key; another operation/body with the key conflicts. Retry after failed transaction must be safe.
- [ ] Cover UNMERGE after moved-away member/newer merge, duplicate reversal, and version-exhaustion rejection. Original events/history are retained. Verify no partial effect after each failed request.
- [ ] Add deterministic concurrency regressions: overlapping merges serialize with one clean state conflict; hold an ingestion shared gate while manual operation waits, then release and verify latest canonical state/current membership; reverse the order and verify ingestion waits then resolves moved link correctly. Preserve the real DB, use barriers instead of timing loops. A controlled second-canonicalization exception must roll back all persisted effects; restore the injected failure hook after the test.
- [ ] Run focused API/policy tests, direct Day 4 regressions, touched lint/format/API typecheck. Verify actual Swagger success/error/body metadata. Report exact evidence. Future group: `feat(entities): add auditable merge split and reversal`; no commit.

## Task 4: Documentation and Final Verification

**Files:** Modify `README.md`, `docs/contracts/mvp-v1.md`, `docs/architecture/overview.md`. Coordination artifacts/reports remain ignored. Any old exact schema/bootstrap expectation directly affected by new enum/scopes must be corrected with its owning implementation task, not by weakening tests.

- [ ] Document request/response/error/status/scope contracts, lifecycle and stable IDs, immutable evidence/audits, required keys and historical replay semantics, reversal conditions/chains, operation limits, concurrency lock order, and Day 6 pending-review behavior.
- [ ] Add detailed PowerShell manual instructions: start/build/migrate, bootstrap action/read scopes, ingest deliberately distinct entities, merge, inspect both IDs/records/canonical/history/audit, keyed replay, update a moved record, undo by merge_event_id and verify original ID/latest data, perform a selected-record split, test denials/conflicts, and inspect SQL/raw-history preservation. Use fresh tenant/source/record suffixes, placeholder keys, clear expected results, and the actual implementation workspace path while work is uncommitted.
- [ ] Format only Day 5 changed files when necessary; run full format check, lint, typecheck/build, Prisma validate, full unit and integration suites once on final code. Run actual migration deploy twice against a disposable schema and clean up only that schema. Diagnose actual failures before fixes; do not rerun broad suites without a change or unresolved concern.
- [ ] Report exact final totals, prerequisites, files and four future logical commit groups. Final independent whole-change review is required; then leave everything uncommitted and link the testing guide for the user. Future group: `docs: document safe entity merge and split`; no commit/push.

## Workflow Decisions

Continue the previously selected subagent workflow without re-asking execution preferences. User's standing delegation opts out of routine design/plan approval pauses; builder check and final implementation review provide concrete reviewable artifacts. Each task gets one scoped review, then one whole-change review; fix only material findings with focused regression evidence. Reuse existing installed dependencies via safe local links, keep workspace packages/generated client local to this worktree, and do not create duplicate package installations.
