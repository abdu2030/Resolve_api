# Day 4 API-Key Authentication and Record Ingestion Implementation Plan

> Execute this plan test-first. Do not commit until the user has reviewed the completed Day 4 work.

**Goal:** Add tenant-derived API-key authentication and scopes, tenant-scoped source registration, and raw, versioned, idempotent `POST /v1/records` ingestion without matching.

**Architecture:** Keep the NestJS modular monolith. Authentication establishes a request principal from the database; controllers remain thin; transactional services own source registration and ingestion; PostgreSQL constraints and advisory locks provide concurrency safety.

**Tech stack:** NestJS, TypeScript, Prisma, PostgreSQL, Jest, Swagger/OpenAPI.

**Approved design:** `docs/superpowers/specs/2026-09-07-day4-auth-ingestion-design.md`

## Execution constraints

- Preserve the original JSON payload separately from normalized fields.
- Derive tenant identity only from the authenticated API key.
- Use explicit scopes and a consistent safe error envelope.
- Keep all tenant-owned queries tenant-scoped.
- Add every database change through a migration.
- Follow red-green-refactor for each task.
- Leave all Day 4 changes uncommitted for user review.

## Task 1: Add Day 4 persistence and migration coverage

**Files:**

- Modify `packages/database/prisma/schema.prisma`
- Create `packages/database/prisma/migrations/20260907120000_day4_auth_ingestion/migration.sql`
- Modify `packages/database/src/index.ts`
- Modify `tests/integration/foundational-schema.integration.ts`
- Create `tests/integration/day4-schema.integration.ts`

1. Add failing integration assertions for the `source_record_versions` and `idempotency_requests` tables, required indexes, positive-version and SHA-256-format checks, response status bounds, and cross-tenant foreign-key denial.
2. Restrict the Day 3 table-count assertion to its six expected table names so later migrations do not invalidate the historical test.
3. Run the focused integration test and confirm it fails because the Day 4 schema is absent.
4. Extend Prisma with `SourceRecord.currentVersion`, nullable `rawPayloadHash`, `SourceRecordVersion`, and `IdempotencyRequest`, including tenant-scoped relations and compound uniqueness.
5. Write the deterministic SQL migration with explicit constraints, indexes, and cross-tenant foreign keys.
6. Export the generated Prisma namespace and required database enums from the database package.
7. Run Prisma validation and generation, then rerun both schema integration suites to green.

## Task 2: Add public contracts and deterministic utilities

**Files:**

- Create `packages/contracts/src/api-scope.ts`
- Create `packages/contracts/src/create-source.dto.ts`
- Modify `packages/contracts/src/record-input.ts`
- Create `packages/contracts/src/record-ingestion-result.ts`
- Modify `packages/contracts/src/index.ts`
- Add corresponding contract unit tests
- Create `apps/api/src/auth/api-key.ts` and `apps/api/src/auth/api-key.spec.ts`
- Create `apps/api/src/records/canonical-json.ts` and `apps/api/src/records/canonical-json.spec.ts`

1. Write failing tests for lowercase source slugs, strict nested Person/Company validation, API-key generation/hash/prefix/bearer parsing, and stable canonical JSON hashing across object-key order while preserving array order.
2. Define the supported scopes `sources:write` and `records:write`, source DTO, conditional record DTO, ingestion operation type, and response contract.
3. Implement API-key generation as `rslv_<environment>_<12 hex>.<43 base64url>` using 32 random secret bytes and SHA-256 storage hashes.
4. Implement canonical JSON serialization with recursive object-key sorting, cycle rejection, and unsupported-value rejection.
5. Run the focused unit tests to green and refactor without changing behavior.

## Task 3: Add safe errors, raw-body capture, authentication, and bootstrap CLI

**Files:**

- Create safe HTTP errors, global exception filter, raw-body request type, and tests under `apps/api/src/common/http/`
- Create auth constants, principal type, decorators, guards, module, bootstrap CLI, and tests under `apps/api/src/auth/`
- Modify `apps/api/src/bootstrap.ts`, `apps/api/src/app.module.ts`, and health metadata
- Modify the infrastructure module to export Prisma globally
- Modify root `package.json`
- Create `tests/integration/day4-api.integration.ts`

1. Write failing tests for the safe `{error:{code,message,details?}}` envelope, preservation of the original raw JSON value, and authentication denial for missing, malformed, unknown, revoked, or inactive-tenant keys. Add a missing-scope test expecting 403.
2. Add a domain-aware API exception and global exception filter that never exposes stack traces or raw database errors.
3. Capture original request bytes through Express JSON verification while retaining strict Nest validation.
4. Implement global authentication and scope guards. Support `@Public()` only for explicitly public routes such as health, and derive the principal only from the API-key row.
5. Update `last_used_at` after successful authentication.
6. Add `npm run auth:bootstrap -- --tenant-name "Local Demo" --environment test`; validate arguments and scopes, create tenant and hashed key transactionally, and print plaintext exactly once.
7. Run focused unit and API integration tests to green.

## Task 4: Implement tenant-scoped source registration

**Files:**

- Create `apps/api/src/common/database/advisory-lock.ts`
- Create source response types, service, controller, module, and tests under `apps/api/src/sources/`
- Modify `apps/api/src/app.module.ts`
- Extend `tests/integration/day4-api.integration.ts`

1. Add failing integration tests: a new source returns 201; the same name/type returns 200 with the same ID; a conflicting type returns 409; another tenant receives a distinct source; concurrent identical requests produce one row.
2. Implement a parameterized transaction-scoped advisory-lock helper using PostgreSQL `pg_advisory_xact_lock(hashtextextended(identity, 0))`.
3. Implement the registration transaction: lock tenant/name, query by tenant/name, return an identical source, reject a type conflict with a domain error, or create it.
4. Expose `POST /v1/sources` behind `sources:write`, with strict validation, stable response mapping, Swagger docs, and no tenant field in the request.
5. Run source unit and integration tests to green.

## Task 5: Implement raw, versioned, idempotent record ingestion

**Files:**

- Create record HTTP types, idempotency-key validation, ingestion service, controller, module, and tests under `apps/api/src/records/`
- Modify `apps/api/src/app.module.ts`
- Extend `tests/integration/day4-api.integration.ts`

1. Add failing integration tests for strict input validation, tenant-scoped source lookup, original raw-country preservation, first version creation, unchanged replay across JSON property order, changed-payload version 2, immutable version 1, entity-type conflict, idempotency replay, idempotency-key reuse conflict, invalid keys, and concurrent natural/keyed retries.
2. Validate optional idempotency keys as 1-255 visible ASCII characters with no whitespace.
3. Parse the captured raw request envelope only after DTO validation and extract its original `data` object for storage.
4. In one transaction, acquire the optional tenant/idempotency lock first and the tenant/source/external-record lock second.
5. Verify the source belongs to the principal tenant. Compute the canonical request and payload hashes.
6. For a new natural record identity, create the stable source record and immutable version 1 and return 201 `CREATED`.
7. For an identical payload hash, write nothing and return 200 `UNCHANGED`.
8. For a changed payload, reject entity-type changes; otherwise create the next immutable version, update the stable raw/current fields, clear derived normalized fields, and return 200 `UPDATED`.
9. If an idempotency ledger row exists with the same operation and request hash, replay its stored status/body and emit `Idempotency-Replayed: true`; reject a different hash with 409. Persist successful first responses in the same transaction.
10. Handle legacy source records without hashes by establishing version 1 safely.
11. Run focused unit, integration, and concurrency tests to green.

## Task 6: Synchronize OpenAPI, documentation, CI coverage, and verification

**Files:**

- Modify OpenAPI/contract tests
- Modify `.github/workflows/ci.yml` only if the existing integration command does not discover the new suites
- Modify `README.md`
- Modify relevant architecture documentation

1. Add failing OpenAPI assertions for both Day 4 paths, bearer security, request/response schemas, the optional `Idempotency-Key` parameter, and documented error envelopes.
2. Complete Swagger annotations and verify the generated document reflects actual statuses and validation.
3. Ensure CI discovers all new unit and integration tests without duplicating commands.
4. Document API-key bootstrap, source registration, record ingestion, idempotency replay, version history, and safe local inspection commands.
5. Run formatting, then run the complete quality gate: Prisma validation/generation, formatting check, lint, typecheck, unit tests, integration tests, build, and Docker Compose configuration validation.
6. Apply the full migration chain to a clean PostgreSQL database twice and verify the migration ledger contains exactly the expected migrations.
7. Start the local stack and perform manual HTTP smoke tests for health, 401, 403, source create/replay/conflict, record create/unchanged/update, idempotent replay/conflict, and cross-tenant isolation.
8. Audit the diff for secrets, accidental PII logging, tenant-unscoped queries, conflict markers, ignored required files, and unrelated edits.
9. Leave the branch uncommitted and provide the user with detailed step-by-step testing instructions.

## Final acceptance checklist

- API keys are hashed at rest and plaintext is shown once only.
- Protected endpoints derive tenant and scopes from credentials.
- Source and record writes are tenant-isolated and concurrency-safe.
- Raw payloads remain available and every changed payload has immutable history.
- Natural record retries and explicit idempotency-key retries do not duplicate effects.
- Matching, normalization, scoring, and entity linking are not introduced in Day 4.
- Tests, OpenAPI, README, migrations, and implementation agree.
- No Day 4 commit or push occurs until the user explicitly approves it.
