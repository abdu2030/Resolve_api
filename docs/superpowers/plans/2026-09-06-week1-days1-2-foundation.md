# Week 1 Days 1-2 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock the first Resolve MVP contracts and create a tested local NestJS, PostgreSQL, Redis, Prisma, and BullMQ foundation.

**Architecture:** Use npm workspaces for separate API and worker applications plus focused contracts, configuration, and database packages. Keep domain behavior out of the scaffold; this milestone exposes health and API documentation while recording later resolution contracts as executable types and fixtures.

**Tech Stack:** Node.js 24, npm workspaces, NestJS, TypeScript, Prisma, PostgreSQL, Redis, BullMQ, Jest, Supertest, ESLint, Prettier, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-06-week1-days1-2-foundation-design.md`

## Global Constraints

- Follow `AGENTS.md` and the Resolve API SRS and blueprint.
- Use a modular monolith with `apps/*` and `packages/*` workspaces.
- Preserve snake_case in external JSON contracts and use strict TypeScript.
- Keep raw source data separate from future normalized data.
- Use normalization version `normalization-v1` and matching version `rules-0.1.0`.
- Use thresholds 0.92 for AUTO_MATCH and 0.72 for REVIEW.
- Do not create domain tables, authentication, ingestion persistence, matching logic, or queue processors in this milestone.
- Do not commit until the user reviews and approves the full milestone.

---

### Task 1: Repository governance and design records

**Files:**

- Create: `AGENTS.md`
- Create: `docs/superpowers/specs/2026-09-06-week1-days1-2-foundation-design.md`
- Create: `docs/architecture/overview.md`
- Create: `docs/contracts/mvp-v1.md`
- Create: `docs/normalization/normalization-v1.md`

**Interfaces:**

- Consumes: the user-supplied engineering rules and approved roadmap.
- Produces: repository-wide constraints and written MVP contracts used by later tasks.

- [ ] Confirm the Git root, branch, and `origin` remote.
- [ ] Place the user-supplied engineering rules in `AGENTS.md` without changing their policy.
- [ ] Record the approved architecture, contract, policy, and milestone boundaries in the design document.
- [ ] Write short architecture, public-contract, and normalization references for contributors.
- [ ] Scan the documents for `TBD`, `TODO`, contradictions, unsupported scope, and accidental secrets.
- [ ] Review `git status --short` and leave all changes uncommitted.

### Task 2: Root workspace and toolchain

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `.gitignore`
- Create: `.dockerignore`
- Create: `.env.example`
- Create: `jest.config.cjs`

**Interfaces:**

- Consumes: the directory boundaries from Task 1.
- Produces: root commands `build`, `typecheck`, `test`, `lint`, `format`, `format:check`, `prisma:generate`, `start:api`, and `start:worker`.

- [ ] Create the root npm manifest with workspaces `apps/*` and `packages/*`, private package protection, Node `>=24`, and exact root scripts.
- [ ] Add strict shared TypeScript options: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, decorator metadata, and Node module resolution.
- [ ] Configure ESLint flat config for TypeScript and Jest files without weakening type errors.
- [ ] Configure Prettier and ignore generated Prisma output, build output, coverage, and dependencies.
- [ ] Ignore secrets, local environment files, generated output, coverage, and editor files while keeping `.env.example` tracked.
- [ ] Install declared dependencies through npm so one root lockfile captures all workspaces.
- [ ] Run `npm install` a second time and confirm the lockfile remains unchanged.
- [ ] Review the diff and leave it uncommitted.

### Task 3: Contracts and golden dataset through TDD

**Files:**

- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/address-input.dto.ts`
- Create: `packages/contracts/src/person-input.dto.ts`
- Create: `packages/contracts/src/company-input.dto.ts`
- Create: `packages/contracts/src/entity-type.ts`
- Create: `packages/contracts/src/record-input.ts`
- Create: `packages/contracts/src/resolution-result.ts`
- Create: `packages/contracts/src/matching-policy.ts`
- Create: `packages/contracts/src/normalization-policy.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/contracts.spec.ts`
- Create: `tests/golden-dataset/mvp-v1.json`
- Create: `tests/golden-dataset/golden-dataset.spec.ts`

**Interfaces:**

- Consumes: the schemas and policies in the design document.
- Produces: `PersonInputDto`, `CompanyInputDto`, `EntityType`, `RecordInput`, `ResolutionResult`, `MATCHING_POLICY`, and `NORMALIZATION_VERSION`.

- [ ] Write a failing Person DTO test that rejects `{}` and whitespace-only identity fields, then run `npm test -- contracts.spec.ts` and confirm the failure names missing identity validation.
- [ ] Implement the smallest class-validator constraint that requires one of `name`, `email`, or `phone`; rerun the focused test until it passes.
- [ ] Write a failing Company DTO test that rejects `{}` and accepts a nonblank `registration_id`; confirm the expected failure.
- [ ] Implement the Company identity constraint for `name`, `domain`, `email`, `phone`, or `registration_id`; rerun the focused test.
- [ ] Add failing tests for malformed emails, blank optional strings, invalid address country codes, and unknown fields at the Nest validation boundary.
- [ ] Implement focused DTO decorators and an address DTO until those tests pass.
- [ ] Add failing compile-time or runtime assertions for the external enums and policy boundaries, then export the typed contracts and centralized policy constants.
- [ ] Add at least eight labeled raw-record pairs covering both entity types, all three decisions, Unicode, formatting differences, missing fields, and blocking contradictions.
- [ ] Write the dataset validator test against the real JSON fixture, confirm that it fails before the complete fixture exists, then make the fixture pass without computing expected values from production policy code.
- [ ] Run the contracts and dataset suites together and confirm zero failures.

### Task 4: Shared environment validation through TDD

**Files:**

- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/src/environment.ts`
- Create: `packages/config/src/index.ts`
- Create: `packages/config/test/environment.spec.ts`

**Interfaces:**

- Consumes: process environment values.
- Produces: `validateEnvironment(input: Record<string, unknown>): EnvironmentConfig` for both applications.

- [ ] Write a failing test with literal input proving valid strings become a typed port number and body-size string.
- [ ] Run the focused test and confirm it fails because `validateEnvironment` does not exist.
- [ ] Implement validation for `NODE_ENV`, `API_PORT`, `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, and `REQUEST_BODY_LIMIT`.
- [ ] Add failing cases for absent URLs, nonnumeric ports, ports outside 1 through 65535, and unsupported environments.
- [ ] Add concise configuration errors that name invalid keys without echoing secret values.
- [ ] Run the environment suite and confirm all branches pass.

### Task 5: Health behavior through TDD

**Files:**

- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/tsconfig.build.json`
- Create: `apps/api/src/health/health.types.ts`
- Create: `apps/api/src/health/database-health.indicator.ts`
- Create: `apps/api/src/health/redis-health.indicator.ts`
- Create: `apps/api/src/health/health.service.ts`
- Create: `apps/api/src/health/health.controller.ts`
- Create: `apps/api/src/health/health.module.ts`
- Create: `apps/api/test/health.service.spec.ts`
- Create: `apps/api/test/health.e2e-spec.ts`

**Interfaces:**

- Consumes: `PrismaClient` and `Redis` through narrow indicator interfaces.
- Produces: `HealthService.check(): Promise<HealthResponse>` and `GET /health`.

- [ ] Write a failing service test proving two successful indicators return `status: "ok"`, `database: "up"`, and `redis: "up"`.
- [ ] Implement the service and stable response types with an injected clock so the test uses a literal timestamp.
- [ ] Write a failing service test proving one rejected indicator returns a safe error response with a `down` check and no dependency message.
- [ ] Implement error mapping without logging or returning raw errors.
- [ ] Write a failing HTTP test proving healthy checks return 200 and the response schema.
- [ ] Implement the thin controller and health module.
- [ ] Write a failing HTTP test proving a dependency failure returns 503 with the safe body.
- [ ] Implement the 503 path and rerun both service and HTTP tests.

### Task 6: API, worker, Swagger, Prisma, and BullMQ scaffold

**Files:**

- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/infrastructure/infrastructure.module.ts`
- Create: `apps/api/test/openapi.e2e-spec.ts`
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/tsconfig.build.json`
- Create: `apps/worker/src/app.module.ts`
- Create: `apps/worker/src/main.ts`
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma.config.ts`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/index.ts`

**Interfaces:**

- Consumes: shared environment validation and Prisma configuration.
- Produces: API and worker entry points, generated Prisma client, BullMQ root connection, `/docs`, and `/docs-json`.

- [ ] Write a failing OpenAPI HTTP test proving `/docs-json` identifies `Resolve API`, version `0.1.0`, and includes `/health`.
- [ ] Create the API module and bootstrap with global validation, `/v1` product prefix exclusions, request-size limit, Swagger UI, and graceful shutdown.
- [ ] Add provider factories for Prisma and Redis and bind the real health indicators to those clients.
- [ ] Define an empty Prisma schema with PostgreSQL datasource and generated client; do not add domain models.
- [ ] Run Prisma generation and import the generated client through `@resolve/database`.
- [ ] Create the worker application context with validated configuration and BullMQ root connection; register no named queue or processor.
- [ ] Rerun OpenAPI, health, type-check, and workspace build commands.

### Task 7: Reproducible local stack and contributor documentation

**Files:**

- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `docker/postgres/init/.gitkeep` only if the directory is required by Compose
- Create: `README.md`

**Interfaces:**

- Consumes: built API, worker, environment contract, PostgreSQL, and Redis.
- Produces: `docker compose up --build`, local health access, Swagger access, and documented verification commands.

- [ ] Create a multi-stage Node image that installs the root lockfile, generates Prisma, builds workspaces, and runs either the API or worker command.
- [ ] Add PostgreSQL and Redis services with named volumes, health checks, and development-only published ports.
- [ ] Add API and worker services with dependency health gates and service-network configuration.
- [ ] Document prerequisites, environment setup, npm commands, the one-command Compose flow, health and Swagger URLs, repository structure, and the milestone boundary.
- [ ] Run `docker compose config` and fix interpolation, dependency, or schema errors.
- [ ] Run `npm run format`, followed by `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run prisma:generate`, and `npm run build`.
- [ ] Run `docker compose up --build -d`, inspect `docker compose ps`, call `/health`, and call `/docs-json`.
- [ ] Stop the stack with `docker compose down` without deleting named volumes.
- [ ] Scan tracked and untracked files for secret material, inspect the full Git diff, and confirm no unrelated file changed.
- [ ] Leave the complete milestone uncommitted for user review.
