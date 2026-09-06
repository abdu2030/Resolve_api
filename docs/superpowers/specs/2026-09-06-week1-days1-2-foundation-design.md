# Week 1 Days 1-2 Foundation Design

## Scope

This milestone covers Week 1 Day 1 and Day 2. It locks the first MVP contracts and creates a runnable local foundation.

It includes Person and Company input schemas, the first resolution response, normalization and scoring policies, a small golden dataset, an npm workspaces scaffold, NestJS API and worker applications, Prisma, PostgreSQL, Redis, BullMQ wiring, Swagger, validation, linting, formatting, tests, and a dependency-aware health endpoint.

Record persistence, domain database models, authentication, source registration, ingestion behavior, normalization implementation, matching, and queue processors belong to later roadmap steps.

## Repository

`C:\Users\Admin\Desktop\Resolve Api` is the repository root. Work uses `feature/week1-foundation` with `https://github.com/abdu2030/Resolve_api.git` as `origin`.

The user reviews all changes before any commit.

## Architecture

The repository uses npm workspaces without Nx or Turborepo:

```text
apps/
  api/
  worker/
packages/
  contracts/
  config/
  database/
docs/
  architecture/
  contracts/
  normalization/
tests/
  golden-dataset/
docker/
```

The API and worker are separate NestJS applications. `packages/contracts` owns public DTOs, enums, and versioned policies. `packages/database` owns Prisma configuration and its reusable client. New packages require roadmap behavior; the scaffold will not contain empty placeholder packages.

PostgreSQL stores durable data. Redis supports BullMQ and short-lived coordination. The API checks PostgreSQL and Redis readiness. The worker connects to BullMQ infrastructure without registering a business processor during this milestone.

## Record Input Contract

The ingestion envelope uses `source`, `external_id`, `entity_type`, and `data`. `entity_type` accepts `person` or `company`. The discriminator selects the data DTO. Validation rejects unknown fields, blank supplied strings, malformed emails, invalid country codes, and unsupported entity types.

An address may contain `line1`, `line2`, `city`, `region`, `postal_code`, and `country`. Country codes use ISO 3166-1 alpha-2 form.

A Person may contain:

- `name`
- `email`
- `phone`
- `company`
- `company_domain`
- `address`
- `attributes`

A Person requires at least one usable value from `name`, `email`, or `phone`.

A Company may contain:

- `name`
- `domain`
- `email`
- `phone`
- `registration_id`
- `address`
- `attributes`

A Company requires at least one usable value from `name`, `domain`, `email`, `phone`, or `registration_id`. The API treats `registration_id` as an opaque source value until a tenant or jurisdiction supplies a trusted validation policy.

## Resolution Response

The first response contains:

```typescript
interface ResolutionResult {
  record_id: string;
  entity_id: string;
  decision: 'AUTO_MATCH' | 'REVIEW' | 'NO_MATCH';
  confidence: number;
  matched_against?: string;
  explanation: {
    features: Record<string, number | boolean | string | null>;
    contradictions: Array<{
      code: string;
      field?: string;
      severity: 'warning' | 'blocking';
      message: string;
    }>;
    candidate_count: number;
  };
  algorithm_version: string;
  created_at: string;
}
```

Confidence stays in the inclusive range 0 through 1. `created_at` uses RFC 3339. Every decision carries structured evidence and an algorithm version.

## Normalization Policy

The first policy identifier is `normalization-v1`. Day 5 will implement these rules. This milestone documents them and exports the version.

- Preserve each raw value and store normalized data as a derived representation.
- Apply Unicode NFKC, trim outer whitespace, and collapse permitted internal whitespace.
- Lowercase name comparison forms and handle punctuation conservatively.
- Trim emails, validate syntax, preserve the local part, and lowercase the domain.
- Do not remove email dots or plus-tags.
- Use country context to derive E.164-style phones. Treat parse failures as missing normalized evidence.
- Normalize company punctuation and retain legal suffix information as a separate signal.
- Lowercase domains, remove schemes, remove one leading `www.`, and remove a trailing dot.
- Normalize address components without deleting distinctions between locations.

## Matching Policy

The first policy identifier is `rules-0.1.0`.

```text
score =
    0.40 * email_signal
  + 0.25 * phone_signal
  + 0.20 * name_similarity
  + 0.10 * company_similarity
  + 0.05 * location_similarity
  - contradiction_penalty
```

The scorer will clamp results to 0 through 1. Thresholds are:

- `score >= 0.92`: `AUTO_MATCH`
- `0.72 <= score < 0.92`: `REVIEW`
- `score < 0.72`: `NO_MATCH`

A blocking contradiction prevents `AUTO_MATCH` regardless of score. Matching code will centralize weights and thresholds, retain the policy version, and evaluate changes against the golden dataset.

## Golden Dataset

`tests/golden-dataset/mvp-v1.json` stores labeled Person and Company pairs. Cases cover whitespace and casing, phone formats, company abbreviations, domain agreement, missing fields, conflicting contact details, conflicting registration identifiers, Unicode, and all three decisions.

Each case has a stable ID, entity type, two raw records, an expected decision, and a rationale. A validator test enforces the fixture schema and coverage. Week 2 matching tests will consume the same data.

## Runtime

Product routes use the `/v1` prefix. Infrastructure routes stay unversioned:

- `GET /health` reports PostgreSQL and Redis readiness.
- `GET /docs` serves Swagger UI.
- `GET /docs-json` serves OpenAPI JSON.

Healthy dependencies produce HTTP 200 with `status: "ok"`, service name, timestamp, and `database` and `redis` checks. A dependency failure produces HTTP 503 with `status: "error"`. Responses do not include credentials, connection strings, stack traces, or raw dependency errors.

The API and worker validate `NODE_ENV`, `API_PORT`, `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, and `REQUEST_BODY_LIMIT` during startup. `.env.example` contains development-safe placeholders.

## Local Stack

`docker compose up --build` starts PostgreSQL, Redis, the API, and the worker. PostgreSQL and Redis use named volumes and health checks. Compose waits for healthy dependencies before starting application services. The API publishes port 3000.

Prisma includes a datasource and generated client but no domain tables. Day 3 owns the first domain migration.

## Testing

Test-first cycles cover configuration validation, Person and Company DTO validation, golden dataset validity, health-state mapping, HTTP 200 and 503 health behavior, and the OpenAPI endpoints.

Completion requires successful formatting, lint, type checking, tests, builds, Prisma generation, Compose validation, and a live stack check. The live check calls `/health` and `/docs-json`, then stops the stack without deleting named volumes.

## Acceptance Criteria

- npm installs all workspaces from one root lockfile.
- API and worker compile under strict TypeScript settings.
- DTO validation rejects unknown fields and unusable identity payloads.
- The repository records the MVP contracts and versioned policies.
- Swagger exposes the service contract.
- Prisma connects to PostgreSQL without premature domain tables.
- BullMQ infrastructure connects to Redis without premature jobs.
- `/health` reflects PostgreSQL and Redis readiness.
- Docker Compose starts the stack through one documented command.
- Formatting, linting, type checking, tests, and builds pass.
- The repository contains no secrets or unrelated changes.
- No commit exists until the user approves the milestone.
