# Day 3 Foundational Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add and verify the tenant-safe foundational PostgreSQL schema and its first migration.

**Architecture:** Prisma defines six tenant-owned models with explicit PostgreSQL mappings, composite tenant foreign keys, record idempotency, and typed blocking columns. A separate Jest integration suite applies the committed migration to an isolated PostgreSQL schema and verifies behavior through real constraints and catalog metadata.

**Tech Stack:** Node.js 24, TypeScript 5.9, Prisma 7.10, PostgreSQL 18, Jest 29, Docker Compose, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-06-day3-foundational-schema-design.md`

## Global Constraints

- Support only Person and Company entities.
- Preserve raw payloads separately from normalized and canonical data.
- Keep PostgreSQL as the durable source of truth.
- Include tenant context in relationships and future access patterns.
- Store API-key hashes and metadata, never plaintext keys.
- Name database constraints and indexes explicitly.
- Do not add authentication, ingestion, normalization, matching, review, merge, or split behavior.
- Do not commit Day 3 work until the user reviews and requests a commit.
- Work in the approved current checkout on `feature/day3-foundational-schema`.

---

### Task 1: Add a failing migration integration suite

**Files:**

- Create: `jest.integration.config.cjs`
- Create: `tests/integration/foundational-schema.integration.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `TEST_DATABASE_URL`, falling back to `DATABASE_URL`.
- Produces: `npm run test:integration`, which applies migrations to a unique PostgreSQL schema and cleans it up.

- [ ] **Step 1: Add the integration Jest configuration**

```js
const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  collectCoverage: false,
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/*.integration.ts'],
  testTimeout: 60_000,
};
```

- [ ] **Step 2: Add the integration test command**

Add this root script:

```json
"test:integration": "node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand"
```

- [ ] **Step 3: Write the migration test harness**

Create a schema name from the process ID and current timestamp. Construct a connection URL with `?schema=<name>`. Invoke Prisma with Node:

```ts
const prismaCli = resolve(repositoryRoot, 'node_modules/prisma/build/index.js');
await execFileAsync(process.execPath, [prismaCli, 'migrate', 'deploy', '--config', prismaConfig], {
  cwd: repositoryRoot,
  env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl },
});
```

Use `pg.Client` for setup, assertions, and cleanup. Query `information_schema.tables`, `pg_indexes`, and `pg_constraint`. Insert tenant, source, record, entity, and link rows with parameterized SQL. Assert PostgreSQL error codes and named constraints for duplicate records (`23505`), cross-tenant references (`23503`), and score range failures (`23514`).

- [ ] **Step 4: Start PostgreSQL**

Run:

```powershell
docker compose up -d postgres
```

Expected: the `postgres` service reaches `healthy`.

- [ ] **Step 5: Run the integration test and confirm RED**

Run:

```powershell
npm run test:integration
```

Expected: FAIL because the six tables and foundational migration do not exist. The failure must come from missing schema behavior rather than test syntax or database connectivity.

### Task 2: Add the Prisma schema and foundational migration

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Modify: `packages/database/package.json`
- Modify: `package.json`
- Create: `packages/database/prisma/migrations/<generated>_foundational_schema/migration.sql`

**Interfaces:**

- Consumes: the table, column, relation, constraint, and index definitions in the approved spec.
- Produces: generated Prisma delegates for `tenant`, `apiKey`, `sourceSystem`, `sourceRecord`, `entity`, and `entityRecordLink`.

- [ ] **Step 1: Define the enums and models**

Add `TenantStatus`, `EntityType`, and `MatchDecision`. Add all six models with UUID keys, `timestamptz(3)` timestamps, JSON fields, snake_case mappings, restrictive foreign keys, and composite tenant-safe relations.

Use these database names:

```prisma
@@unique([tenantId, sourceSystemId, externalId], map: "source_records_tenant_source_external_key")
@@index([tenantId, normalizedEmail], map: "source_records_tenant_normalized_email_idx")
@@index([tenantId, normalizedPhone], map: "source_records_tenant_normalized_phone_idx")
@@index([tenantId, companyDomain], map: "source_records_tenant_company_domain_idx")
@@index([tenantId, entityType, normalizedNamePrefix], map: "source_records_tenant_type_name_prefix_idx")
```

Use this link structure:

```prisma
@@unique([tenantId, sourceRecordId], map: "entity_record_links_tenant_record_key")
@@index([tenantId, entityId], map: "entity_record_links_tenant_entity_idx")
```

- [ ] **Step 2: Add migration scripts**

Add database workspace scripts for `prisma:validate`, `prisma:migrate:dev`, and `prisma:migrate:deploy`. Expose root scripts with the same names through `npm run -w @resolve/database`.

- [ ] **Step 3: Validate and generate the client**

Run:

```powershell
npm run prisma:validate
npm run prisma:generate
```

Expected: Prisma validates the model and generates all six delegates.

- [ ] **Step 4: Generate the migration**

Use a dedicated local schema URL:

```powershell
$env:DATABASE_URL = "postgresql://resolve:resolve@localhost:5432/resolve?schema=day3_migration"
npm run prisma:migrate:dev -- --name foundational_schema --create-only
Remove-Item Env:DATABASE_URL
```

Expected: Prisma creates one timestamped `foundational_schema` migration.

- [ ] **Step 5: Add the score constraint**

Add this SQL after Prisma creates `entity_record_links`:

```sql
ALTER TABLE "entity_record_links"
ADD CONSTRAINT "entity_record_links_score_range"
CHECK ("score" >= 0 AND "score" <= 1);
```

- [ ] **Step 6: Inspect the migration**

Confirm the SQL creates six tables, three enums, required defaults, restrictive foreign keys, composite tenant keys, named uniqueness constraints, and all named indexes. Confirm it contains no table or column drops.

- [ ] **Step 7: Run the integration suite and confirm GREEN**

Run `npm run test:integration`.

Expected: migration, uniqueness, tenant-boundary, index, and score checks pass.

### Task 3: Add CI coverage and documentation

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/architecture/overview.md`

**Interfaces:**

- Consumes: migration and integration-test commands from Tasks 1 and 2.
- Produces: repeatable local and CI schema verification.

- [ ] **Step 1: Add PostgreSQL to CI**

Add a PostgreSQL 18 service with database, user, and password `resolve`, port 5432, and a `pg_isready` health check. Set:

```yaml
env:
  TEST_DATABASE_URL: postgresql://resolve:resolve@localhost:5432/resolve?schema=public
```

- [ ] **Step 2: Run integration tests in CI**

Add `npm run test:integration` after the unit suite and before the production build.

- [ ] **Step 3: Document migrations**

Add README commands for schema validation, client generation, development migration creation, deployment, and integration testing. State that migration tests create and drop an isolated PostgreSQL schema and require the Compose PostgreSQL service.

- [ ] **Step 4: Document the durable model**

Update the architecture note with the six tables, raw/normalized/canonical separation, composite tenant foreign keys, and source-record uniqueness.

- [ ] **Step 5: Format documentation and configuration**

Run `npm run format`.

Expected: Prettier changes only intended Day 3 files.

### Task 4: Verify Day 3

**Files:**

- Verify all Day 3 changes without creating a commit.

**Interfaces:**

- Consumes: Tasks 1 through 3.
- Produces: a verification report and detailed user test instructions.

- [ ] **Step 1: Run quality gates**

Require exit code 0 from:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run prisma:validate
docker compose config --quiet
```

- [ ] **Step 2: Test clean migration deployment**

Use a fresh isolated schema URL, run `npm run prisma:migrate:deploy` twice, and query `_prisma_migrations`. Require one successful migration and no failed or rolled-back record.

- [ ] **Step 3: Test the runtime**

Run:

```powershell
docker compose up --build -d
docker compose ps
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/docs-json
docker compose logs --no-color --tail 100 api worker
docker compose down
```

Require healthy API, PostgreSQL, and Redis services, a running worker, healthy dependency responses, and no startup errors. Use `docker compose down` without `-v`.

- [ ] **Step 4: Audit the tree**

Run `git diff --check`, scan for conflict markers and likely secrets, confirm `.env` and generated Prisma output remain ignored, and inspect `git status --short`. Leave all Day 3 files uncommitted.
