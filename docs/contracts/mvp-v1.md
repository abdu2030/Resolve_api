# MVP v1 Contract

Resolve supports `person` and `company` records. External JSON uses snake_case.

## Human review (`review-v1`, Week 2 Day 6)

| Endpoint                              | Scope           | Behavior                                                                                                                  |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET `/v1/reviews`                     | `reviews:read`  | Bounded newest-first page; status OPEN (default) or RESOLVED; limit1..100 (default25); opaque cursor                      |
| GET `/v1/reviews/:reviewId`           | `reviews:read`  | Original scoring evidence, current records/candidate, captured raw evidence, approval eligibility, optional human outcome |
| POST `/v1/reviews/:reviewId/decision` | `reviews:write` | Atomic APPROVE/REJECT; requires Idempotency-Key; returns200                                                               |

Decision body (no unknown/actor/tenant fields accepted):

```json
{
  "decision": "APPROVE",
  "reason": "Confirmed by reviewer",
  "expected_source_version": 1,
  "expected_candidate_version": 1
}
```

`decision` is APPROVE or REJECT. Reason trims to1..500 Unicode characters.
Source version is an integer1..2147483647; expected candidate version is its
current canonical version, integer0..2147483647. Both come from a fresh detail
read; approval requires both still current. Rejection checks the source version
and may proceed when candidate evidence is stale (candidate version is still
required input, but does not gate rejection).

APPROVE adds the unlinked source to the original same-type ACTIVE candidate.
It refuses changed evidence record versions, moved supporting records, merged
candidates, linked sources, and canonical version exhaustion. It does not follow
merged redirects or silently choose another candidate. Newly created cases capture
both scored record versions. Existing cases retain null versions; only untouched
version1 source/supporting records may be approved. Unknown historical raw snapshots
are null. REJECT creates a new same-type entity from current source data, leaving
the candidate intact. A stale case can therefore be safely resolved as a distinct
identity without accepting outdated matching evidence.

Successful responses contain `review_decision_id`, `review_id`, `decision`,
`reason`, `actor_api_key_id`, `entity_id`, observed `source_record_version`,
`candidate_record_version`, `candidate_canonical_version`, resulting
`canonical_version`, `policy_version: "review-v1"`, and `created_at`.
Actor identity derives solely from the authenticated API-key principal.
The case becomes RESOLVED; exactly one immutable human outcome is stored for
quality analysis. The original machine score/features/explanation/algorithm
are retained. Current field provenance and one REVIEW_APPROVED/REVIEW_REJECTED
canonical snapshot are written in the same transaction.

Idempotency keys use the existing tenant-wide1..255 visible ASCII validation.
Same key/semantic request returns the original200/body and
`Idempotency-Replayed: true`; another operation/body with that key returns409.
Reason trimming and UUID case normalize before hashing. A new key for an already
resolved case returns409 REVIEW_ALREADY_RESOLVED. Failed operations leave no
outcome, link, new entity, snapshot, or idempotency row.

New links retain REVIEW as original machine evidence and add nullable
`review_decision_id`. Entity history exposes that nullable trigger reference and
the full nullable `review_decision` audit object. Fresh ingestion of the linked
record returns linked AUTO_MATCH (approved) or NO_MATCH (rejected) semantics,
the original score/algorithm/explanation, and optional `review_decision_id`.
This is explicit human assignment, not a new automatic score. Old keyed ingestion
responses stay historical. Later merge/split still preserves these audit references.

Errors retain the normal envelope:400 BAD_REQUEST for DTO validation,
INVALID_IDEMPOTENCY_KEY/IDEMPOTENCY_KEY_REQUIRED/INVALID_CURSOR;401 for missing,
invalid, or revoked keys;403 for missing scopes; indistinguishable404
REVIEW_NOT_FOUND for absent/foreign cases. Conflicts include
REVIEW_ALREADY_RESOLVED, REVIEW_RECORD_ALREADY_LINKED,
REVIEW_SOURCE_VERSION_CONFLICT, REVIEW_EVIDENCE_STALE, ENTITY_VERSION_CONFLICT,
and IDEMPOTENCY_KEY_REUSED. Internal failures are sanitized500.
The shared HTTP filter now distinguishes domain error objects from Nest's
string-valued `error`, preserving this envelope for validation failures.

No score policy, thresholds, bulk decisions, alternative candidate selection,
re-scoring endpoint, or quality dashboard is introduced here. Outcomes can be
joined to cases/features for the Day7 evaluation. Evaluate original scorer
evidence only with outcomes whose observed source/supporting versions equal the
captured evidence versions. Legacy unknown versions and changed-version outcomes
remain useful operational audits, but are not labels for that original scored pair.

## Source registration and authorization

Protected requests use `Authorization: Bearer <api-key>`. Tenant identity comes
only from the authenticated key. `POST /v1/sources` requires `sources:write`,
`POST /v1/records` requires `records:write`, and all entity reads require
`entities:read`. Merge requires `entities:merge`; both split modes require
`entities:split`. Review reads require `reviews:read`; decisions require
`reviews:write`. Bootstrap keys include all seven scopes by default. Existing
keys keep their stored scopes.

`POST /v1/sources` accepts:

```json
{
  "name": "verified_crm",
  "type": "api",
  "priority": 10
}
```

Source names and types are lowercase slugs beginning with a letter, followed
by letters, digits, underscores, or hyphens; their maximum lengths are 120 and
50 respectively. `priority` is an optional integer from `0` through `1000`,
defaults to `100`, and is included in the source response alongside
`source_id`, `name`, `type`, and `created_at`. Lower priority values have
higher authority. Existing sources receive priority `100` during migration.
An identical definition returns the existing source. Reusing its name with a
different type returns `409 SOURCE_TYPE_CONFLICT`; a different effective
priority returns `409 SOURCE_PRIORITY_CONFLICT`. Omitting priority means
`100`, including on replay. Registration never updates a source, and no
priority update endpoint is available.

## Record envelope

```json
{
  "source": "crm",
  "external_id": "contact_9234",
  "entity_type": "person",
  "data": {
    "name": "Abdulkerim Hassen",
    "email": "abdul@example.com",
    "phone": "0911223344"
  }
}
```

Person data may contain `name`, `email`, `phone`, `company`, `company_domain`, `address`, and `attributes`. At least one of `name`, `email`, or `phone` must contain text.

Company data may contain `name`, `domain`, `email`, `phone`, `registration_id`, `address`, and `attributes`. At least one identity field must contain text.

Addresses may contain `line1`, `line2`, `city`, `region`, `postal_code`, and a two-letter `country` code.

## Resolution result

```json
{
  "record_id": "rec_01JEXAMPLE",
  "source_id": "src_01JEXAMPLE",
  "external_id": "contact_9234",
  "entity_type": "person",
  "version": 1,
  "status": "STORED",
  "operation": "CREATED",
  "entity_id": "ent_01JEXAMPLE",
  "decision": "AUTO_MATCH",
  "confidence": 0.963,
  "matched_against": "ent_01JEXISTING",
  "explanation": {
    "features": {
      "email_exact": true,
      "phone_exact": true,
      "name_similarity": 0.944
    },
    "contradictions": [],
    "candidate_count": 7
  },
  "algorithm_version": "rules-0.1.0",
  "created_at": "2026-09-06T10:00:00.000Z",
  "updated_at": "2026-09-06T10:00:00.000Z"
}
```

Decisions are `AUTO_MATCH`, `REVIEW`, or `NO_MATCH`. Confidence stays between 0 and 1 and is returned to four decimal places. Every result includes structured evidence and an algorithm version. `matched_against` is the proposed or selected existing entity for `AUTO_MATCH` and `REVIEW`; it is omitted for `NO_MATCH`. A review result creates an open review case without linking the incoming record.

## Canonicalization and survivorship

`canonicalization-v1` consolidates the latest stored versions of all currently
linked records. Canonical state is derived separately from preserved raw
payloads and immutable `source_record_versions`. It does not change
normalization, matching, scoring, or decision policy versions.

Person canonical fields are `name`, `email`, `phone`, `company`,
`company_domain`, and `address`. Company fields are `name`, `domain`, `email`,
`phone`, `registration_id`, and `address`. Address fields are `line1`, `city`,
`region`, `postal_code`, and `country`; `line2` and arbitrary `attributes` are
not canonicalized by this policy. Missing, null, empty, and whitespace-only
values supply no candidate.

Email, phone, domain, and country use stored normalized values. Display names,
company names, street lines, cities, and regions use trimmed,
whitespace-collapsed raw text. Postal codes and registration IDs use trimmed
raw text. Each address component is selected independently, and values are
never invented or combined into synthetic names.

Each field ranks candidates in this order:

1. Lower source priority.
2. Higher field-specific completeness.
3. Newer source-record `updated_at`.
4. Lexicographically smaller source-record ID.

Present exact identifiers (email, phone, domain, country) have completeness
`1`. Text uses Unicode code-point length of its stored normalized comparison
value; company names use the normalized full name. Registration IDs use
trimmed code-point length. Unrelated fields do not affect the winner.
`observed_at` is the source record's `updated_at`, not a customer timestamp.

Selection rules identify the first criterion separating the winning candidate:
`ONLY_CANDIDATE`, `SOURCE_PRIORITY`, `COMPLETENESS`, `RECENCY`, or
`STABLE_TIE_BREAK`. Current provenance describes only field winners. Immutable
canonical snapshots retain the canonical object and full winning provenance
at that version; source histories retain the underlying raw alternatives.

New `NO_MATCH` entities and accepted `AUTO_MATCH` links canonicalize in the
ingestion transaction. A changed linked record recomputes its entity;
`REVIEW` has no accepted link and does not canonicalize. If canonical data and
provenance are unchanged, no new canonical version or snapshot is written.
An unchanged record replay skips recomputation once canonical version is
positive. Idempotency-key replay returns the original response without writes.

Legacy entities begin at `canonical_version: 0`. Reads return their stored
canonical object, `canonicalization_version: null`, and empty provenance;
reads never backfill. The next qualifying ingestion, including an unchanged
linked-record replay without a stored idempotency response, produces one
`LEGACY_BACKFILL` from actual linked records.

## Entity read APIs

All three routes return `200` on success and require `entities:read`. The
`entityId` path parameter is a UUID v4. Entity type values remain lowercase
`person` and `company`; decisions and selection rules are uppercase.
Missing and foreign-tenant entities return the same `404` response.

### `GET /v1/entities/:entityId`

```json
{
  "entity_id": "fd38f3f4-cad4-4506-b545-3d6d570c4fe9",
  "entity_type": "person",
  "status": "ACTIVE",
  "merged_into_entity_id": null,
  "canonical_data": {
    "name": "Abdulkerim Hassen",
    "email": "abdul@example.com"
  },
  "canonical_version": 2,
  "canonicalization_version": "canonicalization-v1",
  "provenance": {
    "name": {
      "source_record_id": "d4aa13ad-30d1-4af6-89f2-e5eefbb1bd44",
      "source_system_id": "33279d15-f528-49c1-bb43-3189dbd77aa4",
      "source_system_name": "verified_crm",
      "external_id": "crm-123",
      "source_priority": 10,
      "raw_value": "  Abdulkerim Hassen ",
      "canonical_value": "Abdulkerim Hassen",
      "selection_rule": "SOURCE_PRIORITY",
      "completeness_score": 17,
      "observed_at": "2026-09-09T10:00:00.000Z",
      "normalization_version": "normalization-v1",
      "canonicalization_version": "canonicalization-v1"
    }
  },
  "record_count": 2,
  "created_at": "2026-09-09T09:00:00.000Z",
  "updated_at": "2026-09-09T10:00:00.000Z"
}
```

The example shows name provenance; each selected field has its own entry.
Address provenance mirrors canonical nesting under `provenance.address`.
Positive-version `canonicalization_version` comes from the latest snapshot.
The entity object, current provenance, count, and latest version are read
from one consistent database snapshot.

### `GET /v1/entities/:entityId/records`

Query parameters: `limit` is an integer `1..100` (default `25`); `cursor` is
an optional opaque value from the preceding page. Order is link creation time
descending, then link ID descending. Use returned cursors without decoding or
modifying them. `next_cursor: null` marks the final page.

```json
{
  "items": [
    {
      "record_id": "d4aa13ad-30d1-4af6-89f2-e5eefbb1bd44",
      "entity_type": "person",
      "external_id": "crm-123",
      "source": {
        "source_system_id": "33279d15-f528-49c1-bb43-3189dbd77aa4",
        "name": "verified_crm",
        "type": "api",
        "priority": 10
      },
      "raw_payload": {},
      "normalized_payload": {},
      "normalization_version": "normalization-v1",
      "record_created_at": "2026-09-09T09:00:00.000Z",
      "record_updated_at": "2026-09-09T10:00:00.000Z",
      "link": {
        "decision": "AUTO_MATCH",
        "confidence": 0.963,
        "algorithm_version": "rules-0.1.0",
        "explanation": {},
        "entity_operation_id": null,
        "linked_at": "2026-09-09T10:00:00.000Z"
      }
    }
  ],
  "next_cursor": null
}
```

Payloads and explanation are abbreviated above. Each item returns the current
raw and normalized record payload plus stored link evidence. `raw_payload`
is deliberately available for authenticated audit use and must not be logged.
Earlier raw versions remain in `source_record_versions`.

### `GET /v1/entities/:entityId/history`

Query parameters: `limit` is an integer `1..100` (default `25`); `cursor` is
an optional opaque value returned by the preceding history page. History is
ordered by version descending. Record and history cursors are not interchangeable.

```json
{
  "items": [
    {
      "version": 2,
      "canonical_data": {},
      "provenance": {},
      "trigger": {
        "operation": "RECORD_UPDATED",
        "source_record_id": "d4aa13ad-30d1-4af6-89f2-e5eefbb1bd44",
        "entity_operation_id": null
      },
      "entity_operation": null,
      "canonicalization_version": "canonicalization-v1",
      "created_at": "2026-09-09T10:00:00.000Z"
    }
  ],
  "next_cursor": null
}
```

Canonical objects and provenance are abbreviated above. Trigger operations
are `ENTITY_CREATED`, `RECORD_LINKED`, `RECORD_UPDATED`, `LEGACY_BACKFILL`,
`MERGE`, and `SPLIT`.
`trigger.source_record_id` may be null. Snapshots are append-only with unique,
sequential entity versions; no update or delete route is exposed. Version-0
entities have an empty history page.

## Manual entity operations (`entity-operations-v1`)

Both POST routes require `Authorization: Bearer <api-key>` and an
`Idempotency-Key` of 1..255 visible ASCII characters without whitespace.
IDs must be UUID v4; comparisons and request hashing lowercase UUIDs. Versions
are integers `0..2147483647`; an entity at the maximum cannot be incremented.
Reasons are trimmed strings of 1..500 characters. Unknown fields are rejected.
Actor and tenant come exclusively from the authenticated principal.

### `POST /v1/entities/:entityId/merge`

Requires `entities:merge`. The path ID is the surviving **target**:

```json
{
  "source_entity_id": "fd38f3f4-cad4-4506-b545-3d6d570c4fe9",
  "expected_source_version": 1,
  "expected_target_version": 2,
  "reason": "Confirmed duplicate identity"
}
```

Returns `200`. Source and target must be different, ACTIVE, same-type,
tenant-owned entities with nonempty membership and current expected versions.
All source links move to the target. The source ID remains readable as a
`MERGED` shell with `merged_into_entity_id` set to the target, zero records,
empty current canonical data/provenance, and intact history. Reads never
redirect automatically. Blocking excludes merged entities.

### `POST /v1/entities/:entityId/split`

Requires `entities:split`. The path ID is the ACTIVE entity losing records.
Exactly one selector is required; supplying both, neither, or null fails validation.

Selected-record mode creates a new ACTIVE entity of the same type and returns
`201`. The selection must be a nonempty proper subset of current membership:

```json
{
  "record_ids": ["d4aa13ad-30d1-4af6-89f2-e5eefbb1bd44"],
  "expected_version": 3,
  "reason": "These records represent another person"
}
```

Duplicate IDs, including case-only duplicates, are invalid. Unknown,
foreign-tenant, and other-entity records all return the same
`404 SOURCE_RECORD_NOT_FOUND`. The source must retain at least one record.

Explicit merge reversal returns `200` and restores the original source ID:

```json
{
  "merge_event_id": "7198e9fe-a1ca-4c6c-b2d6-bd16b93ebeb3",
  "expected_version": 3,
  "reason": "Reversing a mistaken merge"
}
```

The event must be a same-tenant MERGE targeting the path entity. Its source
must still be MERGED directly into that target, the event must not already
be reversed, and all recorded members must remain in the target. The target
must retain another record. Reversal moves exactly those members back,
reactivates the original source, and recomputes from **latest** source values.
Unrelated target ingestions can remain; later source-value updates are safe.
A moved-away member, changed merge chain, or previous reversal prevents a
partial undo. Reverse chains in reverse order. Original merge history remains.

### Operation response and audit

All three actions return this shape; `record_ids` is sorted. On UNMERGE,
`source_entity_id` is the current target losing members, `target_entity_id`
is the original source being restored, and `reversed_operation_id` references
the original MERGE. On selected SPLIT, the target is the newly created ID.

```json
{
  "operation_id": "7198e9fe-a1ca-4c6c-b2d6-bd16b93ebeb3",
  "operation": "MERGE",
  "operation_version": "entity-operations-v1",
  "source_entity_id": "fd38f3f4-cad4-4506-b545-3d6d570c4fe9",
  "target_entity_id": "3bf2dfd5-f2dc-46c0-adc2-ed9b8892c590",
  "record_ids": ["d4aa13ad-30d1-4af6-89f2-e5eefbb1bd44"],
  "reason": "Confirmed duplicate identity",
  "actor_api_key_id": "09818a9a-c7b7-4809-9f10-d8c472d2db09",
  "source_version_before": 1,
  "source_version_after": 2,
  "target_version_before": 2,
  "target_version_after": 3,
  "reversed_operation_id": null,
  "created_at": "2026-10-28T10:00:00.000Z"
}
```

Each successful action appends one immutable operation event and exactly one
canonical snapshot for **each** affected entity, even if field winners do not
change. MERGE uses MERGE snapshot triggers; SPLIT and UNMERGE use SPLIT.
History exposes the complete object as `item.entity_operation` and its ID as
`item.trigger.entity_operation_id`; ingestion-only snapshots have null values.
Raw records/versions, prior canonical snapshots, link IDs/creation times,
confidence/decision/algorithm/explanation, match features, and review cases
are preserved. `link.entity_operation_id` identifies the latest manual move;
it does not replace the original matching evidence. Unkeyed re-ingestion
returns current membership and optional `entity_operation_id` with the
historical link decision/confidence.

An identical successful keyed request returns the original status/body and
`Idempotency-Replayed: true` with no new events, entities, or snapshots. This
is a historical response even after a subsequent reversal or split. A stored
ingestion replay can similarly reference a now-merged readable ID. Use fresh
GETs for current state. Hashes include route/entity, action, and validated
payload; record sets are sorted. Reusing a tenant key for another payload or
operation returns `409 IDEMPOTENCY_KEY_REUSED`. Failed operations store no
ledger row, so a corrected retry can reuse that failed key.

Merge combined membership, or split/reversal current source membership, is
limited to `ENTITY_OPERATION_MAX_RECORDS = 1000`. Reads fetch at most 1001
members and reject overflow with `422 ENTITY_OPERATION_LIMIT`. Request arrays
over 1000 fail validation with `400` instead. Events, links, statuses, canonical
state, two snapshots, and replay ledger commit or roll back together.

Pending review cases retain their historical candidate IDs and evidence.
The review decision service validates stale evidence and merged/moved candidates
before approval; membership operations never automatically rewrite review evidence.

Operation errors use the envelope below. Missing keys return
`400 IDEMPOTENCY_KEY_REQUIRED`; malformed supplied keys return
`400 INVALID_IDEMPOTENCY_KEY`. Missing/foreign entities and events return
indistinguishable `404 ENTITY_NOT_FOUND` or `MERGE_EVENT_NOT_FOUND`.
State/version/type failures use `409 ENTITY_NOT_ACTIVE`,
`ENTITY_VERSION_CONFLICT`, or `ENTITY_TYPE_CONFLICT`. Unsafe selections and
self/empty merges use `INVALID_ENTITY_SPLIT` or `INVALID_ENTITY_MERGE`;
reversal conflicts use `MERGE_ALREADY_REVERSED` or
`MERGE_REVERSAL_CONFLICT`. A detected concurrent membership mismatch uses
`ENTITY_MEMBERSHIP_CONFLICT`. Authentication/scope failures remain `401`/`403`.

See the [PowerShell testing guide](../testing/week2-day5-merge-split-powershell.md)
for executable requests, expected statuses, replay and database checks.

## Errors

Errors use the existing envelope:

```json
{
  "error": {
    "code": "ENTITY_NOT_FOUND",
    "message": "Entity does not exist"
  }
}
```

| Status | Meaning                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid UUID, limit, cursor (including an empty cursor), or source priority/payload validation. Malformed cursors use `INVALID_CURSOR`; ordinary validation uses `BAD_REQUEST`. |
| `401`  | Missing, invalid, or revoked API key.                                                                                                                                           |
| `403`  | Authenticated key lacks the required scope.                                                                                                                                     |
| `404`  | Entity is absent or belongs to another tenant (`ENTITY_NOT_FOUND`).                                                                                                             |
| `409`  | Source replay conflicts (`SOURCE_TYPE_CONFLICT` or `SOURCE_PRIORITY_CONFLICT`), incompatible record identity, or conflicting idempotency-key reuse.                             |
| `422`  | Entity operation membership exceeds 1000 records (`ENTITY_OPERATION_LIMIT`).                                                                                                    |
| `500`  | Unexpected failure, with a sanitized `INTERNAL_ERROR` and no stack trace or customer payload.                                                                                   |
