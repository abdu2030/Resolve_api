# Week 2 Day 5: Safe Merge, Split, and Merge Reversal

**Status:** Design under the user's delegated implementation defaults; final implementation remains subject to user review.

## Goal and Scope

Implement tenant-safe manual merge and split without deleting source truth. Preserve stable entity IDs, original matching evidence, canonical history, and an auditable record of each manual action. A mistaken explicit merge must be reversible.

Use the current NestJS/Prisma/PostgreSQL modular monolith. Add no dependencies, workers, matching algorithms, or threshold changes. Review-case decisions remain Week 2 Day 6 work. Do not commit until the user reviews the implementation and explicitly requests it.

The user has delegated routine choices and asked not to pause for unnecessary questions. The choices below are the implementer's calls, not additional choices claimed to have been explicitly approved by the user.

## Approaches

1. **Retained identities plus append-only operation events (chosen).** Move links transactionally; retain the absorbed entity as a merged shell; recompute both canonical projections. Undo moves the recorded members back to the original entity ID. This preserves references and operates on latest source values.
2. Delete the absorbed entity or restore old database snapshots. Deletion breaks historical references; snapshot restoration risks overwriting source changes accepted after a merge. Neither fits the repository's preservation rules.

## Public Operations

All UUIDs are validated as v4 and normalized to lowercase for comparisons and request hashing. Reject duplicate record IDs, including case-only duplicates. Reasons are trimmed strings of 1..500 characters. Reject unknown request fields. Versions are integers 0..2147483647.

Both POST routes require a valid `Idempotency-Key`, using the existing 1..255 visible-ASCII validation. Missing keys return `400 IDEMPOTENCY_KEY_REQUIRED`. Lock and use the existing tenant idempotency ledger. Hash the route/entity, action, and validated payload; sort record-ID sets before hashing. Reusing a key for another operation or payload returns `409 IDEMPOTENCY_KEY_REUSED`. Successful replays return the original status/body and `Idempotency-Replayed: true` without new events or snapshots. Failed operations leave no ledger row.

### Merge

`POST /v1/entities/:entityId/merge` requires `entities:merge`. The path identifies the surviving target:

```json
{
  "source_entity_id": "uuid",
  "expected_source_version": 1,
  "expected_target_version": 2,
  "reason": "Confirmed duplicate identity"
}
```

Both entities must exist in the authenticated tenant, be ACTIVE, have at least one linked record, and have the same entity type. Reject self-merge and stale canonical versions. Move all current source links to the target, preserving link IDs, timestamps of creation, confidence, decision, algorithm version, and original explanation. Set their last-operation reference to this event. Mark the source MERGED with `merged_into_entity_id` pointing to the target. Its current canonical data/provenance becomes empty; its historical snapshots remain readable. Recompute the target and append a MERGE snapshot for each entity. Return 200 with the operation object below.

### Split Selected Records

`POST /v1/entities/:entityId/split` requires `entities:split`:

```json
{
  "record_ids": ["uuid"],
  "expected_version": 3,
  "reason": "These records represent another person"
}
```

The source must be ACTIVE. Require a nonempty proper subset of its current linked records, all belonging to this tenant/entity. A selected record outside this membership returns `404 SOURCE_RECORD_NOT_FOUND`, identically for nonexistent, foreign-tenant, and other-entity IDs. Create a new ACTIVE entity of the same type, move exactly those links, and recompute both entities with SPLIT snapshots. Keep at least one record in the source. Return 201 with the operation object.

### Reverse an Explicit Merge

The same split route accepts this mutually exclusive form:

```json
{
  "merge_event_id": "uuid",
  "expected_version": 3,
  "reason": "Reversing a mistaken merge"
}
```

Exactly one of `record_ids` and `merge_event_id` is required. The referenced MERGE event must target the path entity and belong to the same tenant. The merge must not already have been reversed. Its original source must still be MERGED directly into this target. Every recorded moved record must still be linked to the target. The target must retain at least one record afterward. Restore the original source to ACTIVE and move exactly the event's recorded members back to its original ID. Use their latest source values, preserving all raw versions and original matching evidence. Append an UNMERGE operation event referencing the original MERGE; append SPLIT canonical snapshots to both entities. Return 200.

Later source-value updates do not prevent reversal. Later unrelated target ingestions remain in the target. A later split that moved a recorded member elsewhere, an already-reversed event, or a merged target prevents unsafe/partial reversal with 409. Merge chains are reversed in reverse order; do not silently follow or modify a chain.

## Bounds and Responses

`ENTITY_OPERATION_MAX_RECORDS = 1000`, centralized in the operation policy. Merge's combined membership and split/reversal source membership must not exceed 1000. Load at most 1001 membership rows before rejecting `422 ENTITY_OPERATION_LIMIT`. This bounds JSON audit payloads and synchronous recomputation in this milestone. Request arrays over 1000 fail DTO validation with 400.

The operation response and historical audit object use this shape:

```ts
interface EntityOperationResult {
  operation_id: string;
  operation: 'MERGE' | 'SPLIT' | 'UNMERGE';
  operation_version: 'entity-operations-v1';
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
```

The actor comes only from the authenticated API-key principal. Store no plaintext key. Record IDs are sorted and are generated/verified against tenant-scoped membership, never trusted as arbitrary audit content.

Errors retain the existing envelope: 400 invalid input/key; 401 missing/invalid/revoked authentication; 403 missing scope; 404 missing or foreign entity/event; 409 relationship/type/state/version/membership conflict; 422 bounded-operation limit; sanitized 500 internal inconsistency. Error text must not expose foreign data. Stable domain codes include `ENTITY_NOT_FOUND`, `MERGE_EVENT_NOT_FOUND`, `ENTITY_NOT_ACTIVE`, `ENTITY_VERSION_CONFLICT`, `ENTITY_TYPE_CONFLICT`, `INVALID_ENTITY_MERGE`, `INVALID_ENTITY_SPLIT`, `MERGE_ALREADY_REVERSED`, and `MERGE_REVERSAL_CONFLICT`.

## Persistence

Add `EntityStatus` enum ACTIVE/MERGED. `entities.status` defaults ACTIVE and `merged_into_entity_id` is nullable. A tenant-safe self foreign key and checks require ACTIVE to have no target and MERGED to have a non-self target. Retain both entity rows and every existing historical relation.

Add append-only `entity_operations` with all fields represented by the operation result (database snake_case, Prisma camelCase). Use JSONB for the bounded `record_ids` array. Add a JSON array/count check, source != target check, nonnegative before/after version checks, and a check that only UNMERGE has a non-null reversed-operation reference. Actor, source, target, and reversed-operation foreign keys must include tenant context. Add the API-key tenant/ID unique key needed by its actor FK; add operation tenant/ID uniqueness and tenant/reversed-operation uniqueness so a merge can be reversed once. Do not add indexes without an actual query pattern.

Add nullable `last_entity_operation_id` to links, referencing a same-tenant event. Link score/decision/explanation remain the original matcher evidence; manual assignment is identified separately by this operation reference.

Add nullable `entity_operation_id` to canonical snapshots, referencing a same-tenant event. Extend canonical trigger operations with MERGE and SPLIT. Structural operations always append exactly one snapshot per affected entity, even when field winners remain identical. Existing ingestion no-op behavior remains unchanged. No new canonicalization-policy version: extraction, ranking, formatting, and stored provenance shape remain `canonicalization-v1`. Operation policy is separately versioned as `entity-operations-v1`.

Each event stores before/after canonical version numbers. Create the event and any new entity before the referencing link/history writes in one transaction. Retain the original MERGE event when reversing; record reversal in a separate UNMERGE event.

## Concurrency and Transaction Order

Existing ingestion locks one record before resolution and canonicalization, so entity locks alone cannot safely coordinate link movement with an in-flight ingestion.

Use a tenant membership gate derived from `entity-membership:${tenantId}`:

- Ingestion acquires a shared transaction advisory lock before source-record writes. Resolution's independently callable service also acquires this shared lock on entry. Re-entrant transaction acquisition is safe.
- Merge/split acquire the exclusive transaction advisory lock before loading membership or writing anything. Normal ingestions can still run concurrently; a rare manual mutation temporarily blocks new ingestion only for that tenant.
- Lock order: optional/required idempotency lock, tenant membership gate, existing record locks (ingestion only), entity canonicalization locks. Management acquires affected entity canonicalization locks in sorted ID order, using the existing `canonicalization:${tenantId}:${entityId}` identity.
- Validate all versions, states, and membership after acquiring locks. Events, link moves, statuses, canonical projections, snapshots, and idempotency ledger commit or roll back together. Never update raw source records or their immutable versions.

Read APIs retain their consistent snapshot behavior. Manual operations must not depend on a network call, Redis durability, or a background job.

## Integration with Existing APIs

- GET entity adds `status` and nullable `merged_into_entity_id`. Old IDs remain readable with their own history. Do not silently redirect reads or delete absorbed identities.
- Linked records add nullable `link.entity_operation_id`. Re-ingestion of a manually moved linked record returns its current entity and an optional `entity_operation_id` on the ingestion response. Its score/decision remain historical matching evidence, not a newly computed manual confidence.
- History trigger adds nullable `entity_operation_id`; history items add nullable `entity_operation` using the complete audit object above. Ingestion-only snapshots have null operation metadata. Keep the existing public snake_case provenance mapping.
- Blocking excludes MERGED entities. With valid link movement, those shells have no members anyway. Existing matching weights, thresholds, features, and normalization/blocking versions remain unchanged.
- Pending review cases and match features retain their original historical candidate IDs/evidence. Day 6 must handle stale/merged candidate state explicitly before applying a human decision. Do not invent review workflows here.
- Existing idempotency responses remain historical responses; replaying an old ingestion key may reference a now-merged readable ID. A fresh unkeyed ingestion returns current membership.

## Acceptance Tests and Documentation

Use real PostgreSQL/HTTP integration for migration, transaction, authorization, idempotency, and concurrency. Pure unit tests may cover membership planning and bounds. Required cases:

- Same-type Person and Company merges; canonical/provenance winners and MERGED shell/history.
- Selected-record split and exact explicit-merge reversal restoring original ID and latest source values.
- Raw records, immutable versions, link IDs, original scores/decisions/explanations, and historical canonical snapshots preserved.
- Key replay creates no additional operation/snapshot/entity; conflicting key and failed-request retry behavior.
- Missing/invalid/revoked keys, missing action scopes, foreign entities/events/record IDs, actor tenancy.
- Self merge including differently cased UUIDs; type mismatch; stale versions; empty/full/duplicate/foreign split sets; both/neither split modes; bounded operations.
- Reversal after unrelated ingestion succeeds; reversal after a moved member leaves or a newer merge changes the target rejects atomically; double reversal rejects.
- Concurrent merge attempts and overlapping ingestion/mutation serialize without duplicate links, stale canonical state, or partial writes. Cross-tenant work remains independent.
- A controlled canonicalization failure rolls back event/link/status/entity/idempotency writes.
- GET entity/records/history and Swagger expose additive metadata with correct nullability; old unmerged behavior remains compatible.

Update README with detailed PowerShell setup, merge, split, reversal, replay, denial, and database-inspection steps and expected results. Update contract/architecture, run full static/build/unit/integration checks and migration replay, and leave changes uncommitted for user review.
