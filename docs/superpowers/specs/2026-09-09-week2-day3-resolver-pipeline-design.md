# Week 2 Day 3 Resolver Pipeline Design

## Goal

Connect the existing ingestion, normalization, blocking, feature extraction,
scoring, and decision code to `POST /v1/records`. The request must finish with
one tenant-scoped outcome: link an automatic match, create and link a new
entity, or create a review case.

## Scope

Day 3 adds orchestration and the persistence needed for review cases and stable
resolution responses. It does not implement canonical survivorship, review
decisions, merge or split operations, background jobs, or webhooks.

The pipeline keeps the existing versions:

- normalization: `normalization-v1`
- blocking: `blocking-v1`
- features: `features-v1`
- scoring and decisions: `rules-0.1.0`

## API Contract

`POST /v1/records` keeps its current ingestion fields and adds:

```json
{
  "entity_id": "uuid",
  "decision": "AUTO_MATCH",
  "confidence": 0.963,
  "matched_against": "uuid",
  "explanation": {
    "candidate_count": 2,
    "features": {
      "email_exact": true,
      "phone_exact": true,
      "name_jaro_winkler_similarity": 0.94
    },
    "contradictions": []
  },
  "algorithm_version": "rules-0.1.0"
}
```

`matched_against` appears for `AUTO_MATCH` and `REVIEW`. For `NO_MATCH`,
`entity_id` identifies the new entity and the response omits
`matched_against`. A review response uses the proposed candidate entity as
`entity_id`; Resolve does not create an entity link until a reviewer decides.

Confidence represents the best candidate's match score. A request with no
candidates returns confidence `0`, empty features and contradictions, and
`candidate_count: 0`.

The API rounds confidence to four decimal places, matching the database's
`DECIMAL(5,4)` evidence and link columns. Candidate ranking and threshold
decisions use the scorer's full precision before this response rounding.

The endpoint keeps its existing `201` response for a new source record and
`200` for updated, unchanged, or idempotency-replayed records. Additive fields
preserve `/v1` compatibility.

## Application Structure

Add `ResolutionService` under `apps/api/src/resolution/`. The service receives
an authenticated tenant ID, a source-record ID, and the active Prisma
transaction. It coordinates candidate generation, comparison, scoring,
evidence persistence, and the selected side effect.

`RecordIngestionService` continues to own source lookup, record versioning,
raw-data storage, normalization, idempotency locks, and response persistence.
After it creates or updates the source record, it calls `ResolutionService`
inside the same transaction and combines the resolution result with the
existing ingestion response.

`CandidateGenerationService.findCandidates` accepts an optional Prisma query
client. Production callers default to the injected client. The resolver passes
its transaction so blocking can read a source record created in that same
transaction.

`RecordsModule` imports `BlockingModule` and provides the resolution service.
The controller remains unchanged apart from its expanded response DTO.

## Candidate Comparison

Blocking returns tenant-scoped candidate entities and their supporting source
records. The resolver loads the incoming record and all supporting records
through composite tenant keys. Each comparison uses the stored raw and
normalized payloads:

```text
extractFeatures(incoming, supporting)
scoreFeatures(features)
```

The resolver stores one `match_features` row for each compared supporting
record. This records rejected candidates as well as the selected candidate.
The stored row includes the feature version, policy version, score inputs,
contribution-level explanation, score, and candidate decision.

The resolver selects the highest-scoring supporting record for each candidate
entity. It uses candidate entity ID and supporting record ID as deterministic
tie breakers.

## Final Decision

The resolver applies these rules after scoring each candidate entity:

1. One candidate has an `AUTO_MATCH` score: select it, even if other candidates
   fall into `REVIEW` or `NO_MATCH`.
2. More than one candidate has an `AUTO_MATCH` score: return `REVIEW`. Add a
   blocking `MULTIPLE_AUTO_MATCH_CANDIDATES` contradiction to the response and
   select the strongest automatic candidate as the proposed entity.
3. No candidate has an automatic score and one or more candidates have a
   `REVIEW` score: return `REVIEW` for the strongest review candidate.
4. All candidates have `NO_MATCH`, or blocking returns no candidates: return
   `NO_MATCH` and create a new entity.

These rules favor precision when two canonical entities both appear to match.
The response's `candidate_count` counts candidate entities, not supporting
source records.

## Persistence and Transactions

Add a tenant-owned `review_cases` table with:

- source record, proposed entity, proposed supporting record, and selected
  match-feature references
- `OPEN` or `RESOLVED` status
- confidence, explanation, algorithm version, and timestamps

A tenant and source-record uniqueness constraint prevents duplicate review
cases. Composite foreign keys enforce tenant isolation for every reference.

Add an `explanation` JSONB column to `entity_record_links`. `AUTO_MATCH` links
the incoming record to the selected existing entity. `NO_MATCH` creates one
entity with empty canonical data, then links the incoming record to it. The
link stores the decision, confidence, explanation, and algorithm version.
Day 3 leaves canonical data empty because later survivorship work must choose
canonical fields with provenance.

The existing source-record advisory lock serializes repeated ingestion for the
same source identity. Before running blocking, the resolver checks for an
existing link or review case. It returns that stored outcome instead of
creating new evidence or side effects. An updated record therefore keeps its
identity decision until a future review, merge, or split workflow changes it.

The ingestion transaction contains these operations:

```text
store or update source record
-> generate candidates
-> compare and score
-> persist match evidence
-> create link and entity, or create review case
-> store idempotency response
-> commit
```

An exception rolls back the full transaction. An idempotency-key replay
returns the stored response before running the resolver.

## Error Handling and Security

The resolver derives the tenant from the authenticated API key. It does not
accept tenant IDs from request data. All source-record, entity, match-feature,
link, and review queries include the tenant ID.

The service maps an unavailable source record or candidate record to a stable
internal error. The API error filter returns its standard response and does
not reveal whether another tenant owns the identifier. Logs must not include
raw payloads or complete identifying fields.

## Testing

Unit tests cover deterministic candidate ranking and the multiple-automatic-
candidate review rule.

PostgreSQL integration tests cover:

- `NO_MATCH` with no candidates creates one entity and one link
- `AUTO_MATCH` links to an existing entity and stores evidence
- `REVIEW` creates an open review case without a link
- two automatic candidates produce a review case
- repeated ingestion returns the stored outcome without duplicate effects
- idempotency replay returns the same response
- tenant isolation for candidate lookup and review references
- a forced failure rolls back the source record, evidence, and decision side
  effects
- the response and OpenAPI schema include the Day 3 fields

The final verification runs Prisma validation and generation, formatting,
linting, type checking, unit tests, integration tests, and the production
build.
