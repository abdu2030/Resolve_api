# MVP v1 Contract

Resolve supports `person` and `company` records. External JSON uses snake_case.

## Source registration and authorization

Protected requests use `Authorization: Bearer <api-key>`. Tenant identity comes
only from the authenticated key. `POST /v1/sources` requires `sources:write`,
`POST /v1/records` requires `records:write`, and all entity reads require
`entities:read`. Bootstrap keys include all three scopes by default.

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
        "source_record_id": "d4aa13ad-30d1-4af6-89f2-e5eefbb1bd44"
      },
      "canonicalization_version": "canonicalization-v1",
      "created_at": "2026-09-09T10:00:00.000Z"
    }
  ],
  "next_cursor": null
}
```

Canonical objects and provenance are abbreviated above. Trigger operations
are `ENTITY_CREATED`, `RECORD_LINKED`, `RECORD_UPDATED`, and `LEGACY_BACKFILL`.
`trigger.source_record_id` may be null. Snapshots are append-only with unique,
sequential entity versions; no update or delete route is exposed. Version-0
entities have an empty history page.

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
| `500`  | Unexpected failure, with a sanitized `INTERNAL_ERROR` and no stack trace or customer payload.                                                                                   |
