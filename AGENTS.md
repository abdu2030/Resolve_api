# RESOLVE API — REPOSITORY ENGINEERING RULES

## 1. Purpose of This File

These rules define how all code in the Resolve API repository must be designed,
implemented, tested, reviewed, documented, and committed.

They apply to:

- Human developers
- GitHub Copilot
- Claude Code
- Cursor
- Codex
- Other AI coding agents
- Pull request reviewers
- Automated refactoring tools

These instructions are authoritative for this repository.

Do not make architectural changes, introduce major dependencies, change core
matching behavior, or alter data integrity rules unless the change is clearly
justified and consistent with these instructions.

---

# 2. Project Identity

Project name:

Resolve API

Full purpose:

Resolve is a multi-tenant entity resolution and data reconciliation API.

Its main responsibility is to receive imperfect records from different source
systems and determine whether those records represent the same real-world
person or company.

Example:

CRM:

    Abdulkerim Hassen
    abdul@example.com
    +251911223344

Billing:

    Abdulkerim H.
    abdul@example.com
    0911223344

CSV:

    ABDULKERIM HASSEN
    abdul@example.com
    +251 911 223 344

These are three records.

They may represent one real-world person.

Resolve must:

1. preserve the original records,
2. normalize comparable fields,
3. find plausible existing candidates,
4. compare the records,
5. calculate evidence,
6. calculate confidence,
7. make a decision,
8. link the record to a canonical entity when appropriate,
9. preserve provenance,
10. keep the decision explainable and auditable.

The core pipeline is:

    INGEST
        ↓
    NORMALIZE
        ↓
    BLOCK
        ↓
    COMPARE
        ↓
    SCORE
        ↓
    DECIDE
        ↓
    CANONICALIZE
        ↓
    PERSIST EVIDENCE
        ↓
    NOTIFY

Never design functionality that bypasses this mental model without a strong
technical reason.

---

# 3. Core Product Promise

The system must make one promise exceptionally well:

> Give Resolve messy person or company records and it returns stable,
> explainable, reversible identity decisions.

Everything else is secondary.

Do not sacrifice correctness for:

- attractive architecture diagrams,
- unnecessary microservices,
- AI features,
- dashboards,
- excessive integrations,
- premature optimization,
- unnecessary abstraction.

The matching core must remain trustworthy.

---

# 4. MVP Scope

The primary supported entity types are:

- Person
- Company

Do not introduce new entity types such as:

- Product
- Device
- Location
- Vehicle
- Supplier
- Account

unless explicitly requested.

The first version should focus on:

- REST API
- source-system registration
- record ingestion
- normalization
- candidate generation
- matching
- confidence scoring
- canonical entities
- provenance
- review cases
- merge/split
- batch processing
- API authentication
- multi-tenancy
- auditability
- webhooks
- observability

Do not turn Resolve into:

- a CRM,
- a data warehouse,
- a full ETL platform,
- a general spreadsheet cleaner,
- an enterprise MDM suite,
- a machine-learning research platform.

---

# 5. Primary Technology Stack

Unless the repository clearly contains a different approved implementation,
use the following stack.

Backend:

    NestJS
    TypeScript

Database:

    PostgreSQL

ORM:

    Prisma

Cache / distributed coordination:

    Redis

Queue:

    BullMQ

API documentation:

    OpenAPI / Swagger

Containerization:

    Docker
    Docker Compose

Testing:

    Jest

CI:

    GitHub Actions

Do not introduce another framework simply because it is convenient for one
feature.

Examples of technologies that should NOT be added without a clear reason:

- Express beside NestJS
- MongoDB beside PostgreSQL
- RabbitMQ beside BullMQ
- Kafka for an MVP-level workload
- Elasticsearch before PostgreSQL indexing has been proven insufficient
- Kubernetes for local development
- GraphQL when REST already satisfies the product requirements

Prefer a smaller coherent stack.

---

# 6. Architecture Rule: Modular Monolith First

Resolve must begin as a modular monolith.

Do NOT split the project into microservices simply to appear production-grade.

A module may later become an independent service only when there is a real
reason such as:

- independent scaling requirements,
- strong failure-isolation requirements,
- separate deployment ownership,
- significantly different resource requirements,
- a justified technology boundary.

Until then, keep business logic within clear modules in one repository.

Expected logical modules include:

    auth/
    tenants/
    sources/
    records/
    normalization/
    matching/
    blocking/
    features/
    scoring/
    decisions/
    entities/
    reviews/
    jobs/
    webhooks/
    audit/
    observability/
    common/

Modules must communicate through clear contracts.

Avoid circular dependencies.

Avoid giant shared utility files.

Avoid putting unrelated business logic inside controllers.

---

# 7. Suggested Repository Structure

Maintain a structure close to:

    resolve-api/
    │
    ├── apps/
    │   ├── api/
    │   └── worker/
    │
    ├── packages/
    │   ├── domain/
    │   ├── normalization/
    │   ├── matching/
    │   ├── database/
    │   ├── observability/
    │   └── contracts/
    │
    ├── migrations/
    │
    ├── tests/
    │   ├── unit/
    │   ├── integration/
    │   ├── contract/
    │   ├── load/
    │   └── golden-dataset/
    │
    ├── docs/
    │   ├── architecture/
    │   └── openapi/
    │
    ├── docker/
    ├── docker-compose.yml
    └── README.md

Do not create random top-level directories without justification.

---

# 8. Domain Terminology Must Remain Consistent

Use the following terminology consistently.

Record

    A representation of something inside one source system.

Entity

    The real-world person or company represented by one or more records.

Source System

    The application or dataset that supplied a record.

External ID

    Identifier assigned by the source system.

Entity Resolution

    Deciding which records represent the same real-world entity.

Canonical Entity

    Resolve's consolidated representation of the real-world entity.

Normalization

    Creating comparable representations without destroying the original value.

Candidate

    An existing entity that might match an incoming record.

Blocking

    Efficiently retrieving plausible candidates without comparing against
    every entity.

Feature

    A measurable matching signal.

Confidence

    Overall strength of evidence that two records belong together.

Provenance

    Information describing where a canonical value originated.

Survivorship Rule

    Rule determining which source value becomes canonical.

Review Case

    A match whose confidence is insufficient for safe automatic resolution.

Do not rename these concepts casually.

---

# 9. Raw Data Is Immutable Source Truth

This is one of the strongest rules in the repository.

Never destroy or silently overwrite the original source record simply because
a normalized or canonical value looks better.

Bad:

    incoming phone = "0911 223 344"

    overwrite raw value with:
    "+251911223344"

Good:

    raw_phone:
        "0911 223 344"

    normalized_phone:
        "+251911223344"

The raw input must remain available for:

- debugging,
- auditing,
- algorithm reproduction,
- provenance,
- disputes,
- future normalization changes.

Canonical data must exist separately from source truth.

---

# 10. Normalization Rules

Normalization must be:

- deterministic,
- testable,
- versioned,
- explainable,
- conservative.

Always preserve raw values.

Normalized values should be derived fields.

Examples:

Name:

    "   ABDULKERIM    HASSEN "

may become:

    "abdulkerim hassen"

Phone:

    "0911 223 344"

with Ethiopian country context may become:

    "+251911223344"

Email:

    "User@EXAMPLE.COM"

may conservatively normalize its domain:

    "User@example.com"

Do NOT apply dangerous global transformations.

For example, never globally assume:

    john.smith@gmail.com

and:

    johnsmith@gmail.com

are identical for every provider.

Likewise, do not globally remove email plus-tags.

Provider-specific normalization must be explicit, configurable, and tested.

Every normalization algorithm must have a version.

Example:

    normalization-v1

or:

    person-normalization-1.2.0

Changing normalization behavior must not make old match decisions impossible
to understand.

---

# 11. Candidate Generation / Blocking Rules

Never compare an incoming record against every entity in a tenant when indexed
candidate generation is possible.

Candidate generation exists to bound expensive work.

Valid blocking signals may include:

- exact normalized email,
- exact normalized phone,
- company domain,
- trusted external identifier,
- surname prefix + email domain,
- phonetic surname + region,
- normalized-name prefix + city.

Use multiple blocking passes where useful.

Conceptually:

    candidates = union(
        exactEmailCandidates,
        phoneCandidates,
        domainCandidates,
        nameLocationCandidates
    )

Then:

    candidates = deduplicate(candidates)

Then:

    candidates = candidates.slice(0, MAX_CANDIDATES)

Candidate count must remain bounded.

Any implementation capable of accidentally generating an unbounded candidate
set must be reviewed carefully.

---

# 12. Database Index Rules

Candidate queries must be supported by appropriate indexes.

Typical indexes include:

    (tenant_id, normalized_email)

    (tenant_id, normalized_phone)

    (tenant_id, company_domain)

    (tenant_id, entity_type, normalized_name_prefix)

    (tenant_id, source_system_id, external_id)

    (tenant_id, entity_id)

Do not add indexes blindly.

Every index should correspond to an actual access pattern.

Use query plans and measurements when optimizing.

---

# 13. Matching Features

Comparison should generate structured evidence.

Example:

    {
      "email_exact": 1.0,
      "phone_exact": 1.0,
      "name_similarity": 0.94,
      "company_similarity": 0.88,
      "city_exact": 1.0
    }

Possible algorithms include:

- exact equality,
- Levenshtein distance,
- normalized edit similarity,
- Jaro-Winkler,
- token Jaccard,
- token-sort similarity,
- phonetic comparison where appropriate,
- domain equality,
- date comparison,
- numeric comparisons.

Prefer understandable algorithms over opaque complexity during the MVP.

Every feature must have a clear semantic meaning.

Avoid features whose result cannot be explained.

---

# 14. Negative Evidence Is Mandatory

The system must consider contradictions as well as similarities.

Do not implement matching as:

    more similarities = always stronger match

Examples of contradictions:

- conflicting trusted legal identifiers,
- incompatible dates of birth,
- incompatible registration IDs,
- clearly different countries where the identity cannot reasonably be shared,
- known source-specific uniqueness violations.

Contradictions may:

- reduce confidence,
- force REVIEW,
- prevent AUTO_MATCH entirely.

Never allow weak similarity signals to overpower very strong contradictory
evidence without explicit policy.

---

# 15. Scoring Rules

Initial deterministic scoring may follow a weighted model such as:

    score =
        0.40 * email_signal
      + 0.25 * phone_signal
      + 0.20 * name_similarity
      + 0.10 * company_similarity
      + 0.05 * location_similarity
      - contradiction_penalty

These weights are not universal truth.

Do not hard-code them throughout the codebase.

Keep scoring policy centralized.

Prefer configuration or versioned domain objects.

Example:

    MatchingPolicy
    ScoreWeights
    DecisionThresholds

Every produced score must be:

    0 <= score <= 1

unless another explicitly documented representation is adopted.

---

# 16. Matching Decisions

Resolve uses three primary decisions:

    AUTO_MATCH
    REVIEW
    NO_MATCH

Suggested initial thresholds:

    score >= 0.92
        AUTO_MATCH

    score >= 0.72 && score < 0.92
        REVIEW

    score < 0.72
        NO_MATCH

Do not silently change thresholds.

Threshold changes affect product behavior and must include:

- tests,
- documentation,
- algorithm/policy version change,
- evaluation against the golden dataset.

---

# 17. Favor Precision Over Aggressive Matching

False positive merges are especially dangerous.

Merging two different people is usually worse than temporarily failing to link
two duplicate records.

Therefore:

When uncertain, prefer:

    REVIEW

instead of:

    AUTO_MATCH

Do not lower thresholds merely to increase match rate.

Matching quality must be measured using:

- precision,
- recall,
- false-positive rate,
- review rate,
- auto-resolution rate.

---

# 18. Every Match Must Be Explainable

Never return only:

    confidence = 0.963

The decision should preserve evidence.

Preferred result:

    {
      "decision": "AUTO_MATCH",
      "confidence": 0.963,
      "features": {
        "email_exact": true,
        "phone_exact": true,
        "name_similarity": 0.944
      },
      "contradictions": [],
      "candidate_count": 7,
      "algorithm_version": "rules-0.1.0"
    }

Store enough information to reproduce or debug the decision.

At minimum consider storing:

- normalization version,
- candidate generation version,
- feature values,
- scorer version,
- thresholds,
- contradiction evidence,
- decision,
- final confidence.

---

# 19. Algorithm Versioning Is Mandatory

Normalization, matching, scoring, and decision policies will evolve.

Do not make historical decisions impossible to reproduce.

Every major resolution decision should contain an algorithm or rule version.

Example:

    rules-0.1.0

or:

    resolver-person-v1.3

Changing matching logic without changing an appropriate version identifier is
not acceptable.

---

# 20. Canonical Entity Rules

A canonical entity is a consolidated representation.

It is NOT a replacement for source records.

Example:

    Entity ent_42

    name:
        Abdulkerim Hassen

    email:
        abdul@example.com

    phone:
        +251911223344

while links may show:

    CRM record crm_123
    Billing record bill_77
    CSV record csv_391

The relationship between canonical entities and source records must remain
explicit.

---

# 21. Provenance Is Mandatory

Canonical fields must preserve their origin where practical.

Example:

    {
      "value": "Acme Trading PLC",
      "chosen_from_record": "crm_183",
      "rule": "source_priority",
      "observed_at": "2026-08-28T10:21:00Z"
    }

The system should be able to answer:

- Which source supplied this value?
- When was it observed?
- Which rule selected it?
- Was the value manually reviewed?
- What values lost the survivorship decision?

Do not create canonical values that appear from nowhere.

---

# 22. Survivorship Rules

Canonical fields should use explicit survivorship rules.

Examples:

Source priority:

    Verified CRM > CSV import

Most recently verified:

    newest verified phone wins

Most complete:

    full legal company name > abbreviation

Field-specific authority:

    billing may own tax ID
    CRM may own sales data

Confidence based:

    select value supported by strongest reliable evidence

Manual lock:

    reviewed field cannot be automatically overwritten

Keep survivorship logic out of controllers.

Create explicit domain services for it.

---

# 23. Merge Safety

Every merge must be auditable and reversible.

Never physically destroy source records to implement a merge.

A merge should primarily affect:

- entity links,
- canonical representation,
- merge history,
- provenance,
- audit events.

Record:

- source entity,
- target entity,
- affected records,
- actor,
- timestamp,
- reason,
- relevant previous state.

---

# 24. Split / Unmerge Is a First-Class Feature

Do not treat split as an afterthought.

Incorrect merges will happen.

The architecture must support:

    merge → discover mistake → split → recompute canonical entities

A split must preserve audit history.

Never delete merge history when reversing a merge.

---

# 25. Idempotency Rules

Retries must be safe.

Repeated ingestion of the same source record must not create duplicate effects.

Source record identity should follow a uniqueness rule similar to:

    UNIQUE (
        tenant_id,
        source_system_id,
        external_id
    )

The API may additionally support:

    Idempotency-Key

Any endpoint that can produce expensive or duplicated side effects should be
reviewed for idempotency.

Especially:

- record ingestion,
- batch creation,
- webhook handling,
- explicit merges,
- retryable jobs.

---

# 26. Multi-Tenancy Is a Security Boundary

Tenant isolation is not optional.

Every tenant-owned resource must belong to exactly one tenant.

Examples:

- source systems,
- source records,
- entities,
- links,
- review cases,
- jobs,
- webhook endpoints,
- audit events.

Every tenant-owned query must include tenant context.

Bad:

    repository.findEntity(entityId)

Good:

    repository.findEntity({
        tenantId,
        entityId
    })

Tenant identity must come from authenticated credentials.

Never trust:

    request.body.tenant_id

for authorization.

Never generate candidates across tenants.

Never perform cross-tenant fuzzy search.

Never expose another tenant's records through IDs, errors, logs, webhooks, or
timing shortcuts.

---

# 27. API Key Security

API keys should look identifiable but remain secret.

Example:

    rslv_live_xxxxxxxxx

Store only a secure hash of the secret key.

The plaintext secret should normally be shown only once.

Keys should support metadata such as:

- tenant,
- prefix,
- scopes,
- creation timestamp,
- revocation timestamp,
- last-used timestamp.

Never:

- commit API keys,
- log complete API keys,
- return stored API keys,
- store plaintext secrets in PostgreSQL.

---

# 28. Authorization

Every protected operation must check:

    tenant
    +
    scope / permission

Examples of possible scopes:

    records:write
    records:read
    entities:read
    entities:merge
    entities:split
    reviews:read
    reviews:write
    webhooks:manage

Do not rely solely on endpoint obscurity or UI restrictions.

Authorization must happen server-side.

---

# 29. API Design

The API should remain:

- predictable,
- versioned,
- boring,
- consistent,
- idempotent where appropriate.

Use versioned routes:

    /v1/...

Core endpoint direction:

    POST /v1/sources

    POST /v1/records

    POST /v1/records/batch

    GET /v1/jobs/:jobId

    GET /v1/entities/:entityId

    GET /v1/entities/:entityId/records

    GET /v1/entities/:entityId/history

    POST /v1/entities/:entityId/merge

    POST /v1/entities/:entityId/split

    GET /v1/reviews

    POST /v1/reviews/:reviewId/decision

    POST /v1/webhook-endpoints

Keep naming consistent.

Do not introduce verbs into REST paths unnecessarily.

Prefer:

    POST /entities/:id/merge

over:

    POST /performEntityMergeOperation

---

# 30. HTTP Status Codes

Use meaningful status codes.

Typical meanings:

    200
    successful operation

    201
    created resource

    202
    async work accepted

    400
    malformed request

    401
    invalid or missing authentication

    403
    authenticated but unauthorized

    404
    resource does not exist in tenant

    409
    conflict

    422
    valid JSON but invalid domain payload

    429
    rate limit exceeded

    500
    internal error

    503
    temporary dependency/service failure

Error responses should have a consistent schema.

Never expose stack traces in production responses.

---

# 31. DTO and Input Validation

Every externally supplied payload must be validated.

Use NestJS DTOs and explicit validation.

Reject:

- unknown dangerous fields,
- malformed emails,
- invalid enums,
- excessive payload size,
- impossible combinations,
- unsupported entity types.

Prefer strict validation.

Do not directly spread untrusted request bodies into database operations.

Bad:

    prisma.entity.create({
        data: req.body
    })

Good:

    validated DTO
        ↓
    explicit mapping
        ↓
    domain/service
        ↓
    repository

---

# 32. Controllers Must Stay Thin

Controllers should mainly:

- authenticate,
- validate input,
- call application services,
- map response,
- translate expected errors.

Controllers should NOT contain:

- matching algorithms,
- Prisma query logic,
- normalization rules,
- scoring formulas,
- queue retry rules,
- survivorship logic.

Move business logic into domain/application services.

---

# 33. Service Layer Responsibilities

Services should represent meaningful operations.

Examples:

    RecordIngestionService
    NormalizationService
    CandidateGenerationService
    FeatureComparisonService
    MatchingService
    ScoringService
    DecisionService
    EntityResolutionService
    CanonicalizationService
    MergeService
    SplitService
    ReviewService

Do not create meaningless generic services such as:

    UtilsService
    HelperService
    GeneralService

unless their responsibility is truly infrastructure-wide.

---

# 34. Database Transaction Rules

Use transactions whenever multiple writes must succeed or fail together.

Examples:

- source record creation + entity link creation,
- entity merge operations,
- entity split operations,
- canonical entity recomputation,
- review approval + link update,
- audit event paired with critical state changes.

Do not leave critical workflows partially committed.

Think explicitly about concurrency.

---

# 35. Concurrency

Assume requests can happen simultaneously.

Potential races include:

- same source record submitted twice,
- same entities merged concurrently,
- split during resolution,
- multiple workers processing same retry,
- canonical entity recomputation during new ingestion.

Use:

- database constraints,
- transactions,
- optimistic/pessimistic controls where appropriate,
- idempotency,
- queue job uniqueness,

instead of hoping operations happen sequentially.

---

# 36. Redis Rules

Redis may be used for:

- BullMQ backend,
- rate-limit counters,
- short-lived cache,
- distributed coordination where justified.

Do not treat Redis as the permanent source of truth.

PostgreSQL is the durable system of record.

Cached data must be safe to lose and recompute.

---

# 37. Queue Rules

Use BullMQ for operations that should not block synchronous API requests.

Examples:

- batch imports,
- backfills,
- large resolution jobs,
- webhook delivery,
- canonical recomputation,
- export/import tasks.

Job lifecycle should support states conceptually similar to:

    QUEUED
        ↓
    RUNNING
        ↓
    SUCCEEDED

or:

    RUNNING
        ↓
    RETRYING
        ↓
    RUNNING

and eventually:

    FAILED
        ↓
    DEAD LETTER / MANUAL RETRY

Jobs must be retry-safe.

---

# 38. Synchronous vs Asynchronous Work

Single-record resolution with a small candidate set may remain synchronous.

Do not unnecessarily queue every operation.

Use asynchronous processing when:

- workload is large,
- operation is long-running,
- retries are expected,
- work should survive API restarts,
- external delivery is involved.

The API request path should avoid slow external dependencies where possible.

---

# 39. Webhook Rules

Webhook delivery must assume at-least-once semantics.

Each event should contain a unique event identifier.

Clients may receive duplicates.

Webhook design must therefore support idempotency.

Required concerns include:

- HMAC signing,
- retries,
- exponential backoff,
- jitter,
- delivery attempt history,
- replay capability,
- dead-letter handling.

Never claim exactly-once network delivery.

---

# 40. SSRF Protection for Webhooks

Customer-controlled webhook URLs are security-sensitive.

Do not simply call arbitrary URLs.

Validate:

- scheme,
- hostname,
- resolved IP,
- redirects.

Where appropriate block:

- localhost,
- loopback addresses,
- private networks,
- link-local networks,
- cloud metadata addresses.

Revalidate redirect targets.

---

# 41. Logging Rules

Use structured logs.

Good:

    {
      "event": "resolution.completed",
      "tenantId": "...",
      "recordId": "...",
      "decision": "AUTO_MATCH",
      "score": 0.963,
      "candidateCount": 7,
      "algorithmVersion": "rules-0.1.0"
    }

Avoid logging unnecessary PII.

Do NOT casually log:

- complete emails,
- complete phone numbers,
- full customer payloads,
- API keys,
- authentication headers,
- secrets.

Mask or hash sensitive values where correlation is necessary.

---

# 42. Observability

Important metrics include:

HTTP:

- request count,
- error rate,
- p50 latency,
- p95 latency,
- p99 latency,
- 429 count.

Resolution:

- records processed,
- auto-match rate,
- review rate,
- no-match rate.

Quality:

- review approval rate,
- reported false positives,
- split/unmerge rate.

Blocking:

- candidate count distribution,
- zero-candidate rate,
- blocking hit rate.

Queue:

- queue depth,
- oldest job age,
- retry count,
- failed jobs.

Webhooks:

- success rate,
- attempt count,
- delivery age,
- dead-letter count.

Database:

- slow queries,
- connection saturation,
- lock waits.

Never optimize something simply because it "feels slow".

Measure first.

---

# 43. Testing Is Required

Every meaningful behavior requires appropriate tests.

Test categories:

    unit
    integration
    contract
    concurrency
    migration
    security
    load
    golden dataset

Matching changes require especially strong tests.

---

# 44. Unit Tests

Unit-test:

- normalization,
- comparison algorithms,
- scoring,
- decision thresholds,
- contradiction rules,
- survivorship rules,
- utility domain functions.

Unit tests should be deterministic.

Avoid network calls.

---

# 45. Integration Tests

Integration tests should validate interactions among:

    NestJS
    PostgreSQL
    Redis
    BullMQ

Examples:

- ingest record,
- create new entity,
- ingest matching record,
- link existing entity,
- create review case,
- approve review,
- merge,
- split,
- process batch job.

Use realistic database constraints.

---

# 46. Golden Dataset

Maintain a version-controlled labeled matching dataset.

Example:

    {
      "recordA": {...},
      "recordB": {...},
      "expected": "MATCH"
    }

Include:

- spelling variation,
- whitespace differences,
- capitalization,
- phone formats,
- missing fields,
- company abbreviations,
- shared names,
- shared phone numbers,
- conflicting values,
- Unicode,
- country differences.

Any major scoring or threshold change should be evaluated against the golden
dataset.

Do not tune matching behavior solely from intuition.

---

# 47. High-Value Edge Cases

Always consider cases such as:

- same email but conflicting legal identifiers,
- same name and city but different phone and email,
- shared family phone number,
- renamed company with unchanged domain,
- identical company names in different countries,
- Unicode names,
- accents,
- null vs empty vs missing,
- duplicate Idempotency-Key,
- duplicate webhook delivery,
- retry after DB commit but before HTTP response,
- simultaneous merge attempts,
- split followed by re-resolution.

---

# 48. Security Tests

Test:

- cross-tenant entity access,
- cross-tenant candidate generation,
- invalid API key,
- revoked API key,
- missing scope,
- privilege escalation,
- payload validation,
- rate limits,
- webhook SSRF protections,
- secret leakage,
- sensitive logging.

A security feature is incomplete until there is at least one test proving the
expected denial behavior.

---

# 49. Performance Rules

Do not optimize randomly.

The primary performance risk is candidate comparison.

Focus first on:

- indexed candidate lookup,
- bounded candidate counts,
- efficient deterministic feature computation,
- batch-friendly database operations.

Never introduce distributed architecture simply because the dataset might grow
someday.

Scale based on evidence.

---

# 50. Machine Learning Restrictions

Do NOT add ML, embeddings, or LLM-based matching to the core MVP merely because
they sound advanced.

The deterministic matcher must work first.

ML may be introduced later only when:

- a labeled dataset exists,
- deterministic weaknesses are measurable,
- improvement can be evaluated objectively,
- explainability risks are understood.

Possible future capabilities include:

- probabilistic linkage,
- supervised classifiers,
- active learning,
- embeddings,
- graph resolution,
- source quality modeling.

They are not MVP requirements.

---

# 51. No Premature Microservices

Do not create services such as:

    normalization-service
    scoring-service
    entity-service
    webhook-service

as independently deployed applications during the initial build.

Keep them as code modules first.

Complexity must be earned.

---

# 52. Code Quality

TypeScript must use strict typing.

Avoid:

    any

unless unavoidable and justified.

Prefer:

    unknown

with narrowing.

Use:

- meaningful names,
- explicit return types where valuable,
- domain enums,
- small focused functions,
- constructor dependency injection,
- reusable domain types.

Do not create abstractions before repeated need appears.

---

# 53. Function Rules

Functions should preferably perform one clear responsibility.

Bad:

    processEverything()

Good:

    normalizePersonRecord()
    generateCandidates()
    compareCandidate()
    calculateConfidence()
    decideMatch()
    updateCanonicalEntity()

Avoid very large functions.

Extract meaningful domain behavior instead of arbitrary helper functions.

---

# 54. Naming Rules

Use domain terminology.

Good:

    candidateEntities
    normalizedPhone
    matchConfidence
    contradictionPenalty
    canonicalEntity
    sourceRecord
    reviewCase

Bad:

    stuff
    data2
    obj
    arr
    tmp
    helperThing

Database model and code naming should remain conceptually aligned.

---

# 55. Comments

Comments should explain WHY, not narrate obvious code.

Bad:

    // increment retry count
    retryCount++

Good:

    // Webhook delivery uses at-least-once semantics.
    // Retrying is safe because event_id is stable across attempts.

Important matching policy decisions should include explanatory comments or
documentation.

---

# 56. Error Handling

Use domain-specific errors.

Examples:

    EntityNotFoundError
    TenantAccessDeniedError
    InvalidMergeError
    InvalidSplitError
    ReviewAlreadyResolvedError
    CandidateLimitExceededError

Do not throw raw strings.

Do not swallow errors.

Do not convert every exception into HTTP 500 without classification.

---

# 57. Configuration

Do not hard-code environment-specific values.

Use configuration for:

- database URLs,
- Redis URLs,
- API key settings,
- rate limits,
- queue settings,
- webhook retry policy,
- matching thresholds where appropriate,
- candidate limits.

Provide:

    .env.example

Never commit actual secrets.

---

# 58. Documentation

Update documentation whenever a change affects:

- public API,
- matching behavior,
- architecture,
- environment variables,
- setup commands,
- database schema,
- queue behavior,
- security assumptions.

Swagger/OpenAPI should remain synchronized with implementation.

README should contain:

- project purpose,
- architecture summary,
- local setup,
- environment variables,
- start commands,
- test commands,
- API docs location.

---

# 59. Database Migration Rules

Every schema change must use a migration.

Do not manually modify production database structure.

Migration changes should be:

- reviewed,
- deterministic,
- safe for existing data where possible.

Indexes, uniqueness constraints, and foreign keys should be included explicitly.

Test migrations before merging.

---

# 60. API Backward Compatibility

Do not casually break `/v1`.

If a change breaks existing clients:

- introduce compatible fields,
- deprecate old behavior,
- or create a future API version.

Adding fields is generally safer than removing or renaming them.

---

# 61. Git Branch Rules

Use focused branches.

Examples:

    feature/record-ingestion
    feature/person-normalization
    feature/candidate-blocking
    feature/review-workflow
    fix/idempotency-race
    fix/cross-tenant-query
    refactor/matching-policy
    test/golden-dataset
    docs/api-authentication

Avoid:

    test
    new
    work
    branch1
    final-final

One branch should represent one coherent change.

---

# 62. Commit Message Rules

Use Conventional Commit-style messages.

Allowed examples:

    feat(records): add idempotent record ingestion

    feat(matching): implement Jaro-Winkler name similarity

    feat(blocking): add normalized phone candidate lookup

    feat(entities): add reversible merge workflow

    fix(auth): prevent cross-tenant entity access

    fix(webhooks): block private network destinations

    test(matching): add conflicting birthdate cases

    refactor(scoring): extract versioned matching policy

    docs(api): document record resolution response

    chore(ci): add PostgreSQL integration test service

Preferred format:

    type(scope): concise description

Do not use meaningless messages such as:

    update
    changes
    fix stuff
    final
    working now
    test
    done

Each commit should represent a logically understandable unit of work.

---

# 63. Commit Size

Prefer small meaningful commits.

Do not mix:

- formatting,
- database redesign,
- API changes,
- matching behavior,
- tests

inside one giant commit unless they are inseparable.

A reviewer should be able to understand why each commit exists.

---

# 64. Pull Request Rules

Every significant PR should explain:

## What changed?

Describe the implementation.

## Why?

Explain the problem being solved.

## How?

Describe the technical approach.

## Matching impact

State whether normalization, blocking, scoring, or thresholds changed.

## Database impact

List schema or migration changes.

## Security impact

State tenant, authentication, PII, or webhook implications.

## Tests

Describe tests added or executed.

## Breaking changes

State whether API compatibility changes.

---

# 65. Pull Request Checklist

Before requesting review verify:

    [ ] Project builds successfully

    [ ] TypeScript passes

    [ ] Lint passes

    [ ] Unit tests pass

    [ ] Integration tests pass where relevant

    [ ] Database migration tested

    [ ] No secret committed

    [ ] No sensitive PII logging introduced

    [ ] Tenant scoping checked

    [ ] API docs updated if needed

    [ ] Matching version updated if matching semantics changed

    [ ] Golden dataset evaluated if scoring changed

    [ ] Error states handled

    [ ] New functionality documented

---

# 66. AI Agent Rules

When an AI coding agent works on this repository, it MUST:

1. Read this file before modifying code.

2. Inspect the existing project structure before creating new folders.

3. Reuse existing abstractions when appropriate.

4. Never assume a missing feature should be implemented with a new dependency.

5. Never replace architecture wholesale without explicit instruction.

6. Never weaken tenant isolation.

7. Never remove validation to make tests pass.

8. Never delete failing tests unless the test is demonstrably incorrect.

9. Never suppress TypeScript errors using `any` or `@ts-ignore` simply to make
   code compile.

10. Never remove database constraints to bypass implementation difficulty.

11. Never expose API keys or secrets.

12. Never overwrite source data during normalization.

13. Never implement irreversible entity merges.

14. Never alter scoring thresholds silently.

15. Never introduce cross-tenant matching.

16. Never add ML or LLM matching unless explicitly requested.

17. Always add or update tests for behavior changes.

18. Always preserve existing public API behavior unless breaking changes are
    explicitly requested.

19. Prefer the smallest correct change.

20. Explain architectural tradeoffs before introducing substantial complexity.

---

# 67. AI Agent Workflow Before Coding

Before implementing a task:

STEP 1

Read the relevant module.

STEP 2

Identify existing patterns.

STEP 3

Determine affected:

- domain logic,
- API,
- database,
- security,
- tests.

STEP 4

Write a short implementation plan internally.

STEP 5

Implement the smallest coherent change.

STEP 6

Add tests.

STEP 7

Run relevant checks.

STEP 8

Review the diff.

STEP 9

Verify no unrelated files changed.

STEP 10

Summarize what changed.

---

# 68. AI Agent Must Not Invent Requirements

If requirements are unclear:

Do not silently invent business behavior.

For example, do not decide independently:

- new scoring weights,
- new decision thresholds,
- tenant matching rules,
- source priority,
- merge conflict policy,
- retention period.

Use existing documented behavior.

If no behavior exists, identify the missing requirement.

---

# 69. Definition of Done

A feature is not complete merely because the happy path works.

A feature is complete when:

- implementation is correct,
- validation exists,
- tenant isolation is enforced,
- errors are handled,
- tests exist,
- concurrency is considered where relevant,
- logs do not leak sensitive data,
- docs are updated when needed,
- code passes CI,
- behavior matches project domain rules.

---

# 70. MVP Acceptance Direction

The repository should ultimately prove that:

- developers can authenticate with an API key,
- tenants and sources can be registered,
- record ingestion is idempotent,
- records are normalized deterministically,
- candidate generation uses indexed blocking,
- candidate comparison produces structured evidence,
- decisions produce confidence and explanation,
- high-confidence records can auto-match,
- ambiguous records enter review,
- low-confidence records create new entities,
- canonical data preserves provenance,
- merges are reversible,
- split is supported,
- batch work survives worker restarts,
- tenant isolation is enforced,
- local development starts reproducibly.

---

# 71. Final Engineering Principle

Whenever there are two implementation choices, prefer the one that makes
Resolve:

1. more correct,
2. more explainable,
3. safer,
4. more reversible,
5. easier to test,
6. easier to operate,

before preferring the option that merely looks more sophisticated.

Resolve should earn complexity.

Do not add complexity before the core identity-resolution loop proves it is
necessary.
