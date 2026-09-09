# Resolve API

Resolve links imperfect Person and Company records to stable canonical entities. It preserves source truth and produces explainable, versioned, reversible identity decisions.

## Current milestone

Week 1 Days 1-7 provide the repository foundation, locked MVP contracts, NestJS application shells, PostgreSQL and Redis infrastructure, tenant API-key authentication, source registration, raw record ingestion, deterministic Person/Company normalization, bounded candidate blocking, and a realistic integration checkpoint.

The API stores each source record under a stable tenant/source/external identity. Changed payloads create immutable history rows; identical retries create no new raw version. Each accepted record stores separate `normalization-v1` payload and indexed projections while preserving the submitted source data. Internal `blocking-v1` retrieves only tenant-local, same-type linked entity candidates through bounded indexed passes. The Day 7 CRM, billing, and CSV acceptance dataset verifies these behaviors together against PostgreSQL. Comparison, scoring, decisions, and automatic entity linking begin on later roadmap days.

## Architecture

Resolve is an npm-workspaces modular monolith. The NestJS API handles HTTP and readiness, the NestJS worker hosts BullMQ background processing, PostgreSQL is durable storage, and Redis provides queue and coordination infrastructure. Shared contracts, configuration, Prisma access, and pure normalization rules live in focused packages. See `docs/architecture/overview.md` for the process boundaries and persistence model.

## Environment variables

| Variable                  | Purpose                                                | Example/default                     |
| ------------------------- | ------------------------------------------------------ | ----------------------------------- |
| `NODE_ENV`                | Runtime mode: `development`, `test`, or `production`   | `development`                       |
| `API_PORT`                | Host port used by the API                              | `3000`                              |
| `BLOCKING_MAX_CANDIDATES` | Final candidate cap; integer from 1 through 1000       | `100`                               |
| `DATABASE_URL`            | PostgreSQL connection string used by Prisma            | Local Compose URL in `.env.example` |
| `TEST_DATABASE_URL`       | Optional URL used by database integration tests        | `DATABASE_URL`, then local Compose  |
| `REDIS_HOST`              | Redis hostname                                         | `localhost`                         |
| `REDIS_PORT`              | Redis port                                             | `6379`                              |
| `REQUEST_BODY_LIMIT`      | Maximum JSON request body size                         | `1mb`                               |
| `POSTGRES_DB`             | Compose PostgreSQL database name                       | `resolve`                           |
| `POSTGRES_USER`           | Compose PostgreSQL user                                | `resolve`                           |
| `POSTGRES_PASSWORD`       | Compose PostgreSQL password for local development only | `resolve`                           |

The application validates required runtime variables and the optional candidate limit at startup. Validation reports only the invalid variable name, never its value.

## Prerequisites

- Node.js 24 or newer
- npm 11 or newer
- Docker Desktop with Docker Compose
- Git

## Install

PowerShell:

```powershell
Copy-Item .env.example .env
npm ci
npm run prisma:generate
```

The `.env` file stays untracked. Change its development credentials if other users can access your machine.

## Apply database migrations

Start PostgreSQL and apply every committed migration:

```powershell
docker compose up -d --wait postgres
npm run prisma:validate
npm run prisma:migrate:deploy
```

When a future schema change needs a new development migration, use a descriptive name:

```powershell
npm run prisma:migrate:dev -- --name descriptive_name
```

Never edit a deployed database by hand. Commit the Prisma schema and generated migration together.

## Create a local tenant and API key

Apply the migrations, then run the bootstrap command:

```powershell
npm run auth:bootstrap -- --tenant-name "Local Demo" --environment test
```

The command prints the tenant ID, API-key ID, and plaintext key. Copy the plaintext key when it appears; PostgreSQL stores only its SHA-256 hash. The default key has `sources:write` and `records:write` scopes. Use `--scopes records:write` or `--key-name "Importer"` when you need a narrower key or a descriptive name.

## Register a source and ingest records

Set the key returned by the bootstrap command:

```powershell
$resolveApiKey = 'rslv_test_replace_this_value'
$resolveHeaders = @{ Authorization = "Bearer $resolveApiKey" }
```

Register a tenant-local source:

```powershell
$source = Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/sources `
  -Headers $resolveHeaders -ContentType 'application/json' `
  -Body '{"name":"crm","type":"api"}'
```

Ingest a Person record:

```powershell
$recordBody = '{"source":"crm","external_id":"contact_9234","entity_type":"person","data":{"name":"Abdulkerim Hassen","email":"abdul@example.com","address":{"country":"et"}}}'
$record = Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/records `
  -Headers $resolveHeaders -ContentType 'application/json' -Body $recordBody
```

The first request returns `CREATED` with version 1. Repeating the same logical payload returns `UNCHANGED`. Changing a value returns `UPDATED` and increments the version while retaining prior raw payloads in `source_record_versions`. The same transaction stores `normalization-v1` values in the separate normalized columns.

For explicit request replay, add an idempotency key:

```powershell
$resolveIdempotentHeaders = @{
  Authorization = "Bearer $resolveApiKey"
  'Idempotency-Key' = 'contact-9234-create'
}
Invoke-WebRequest -Method Post -Uri http://localhost:3000/v1/records `
  -Headers $resolveIdempotentHeaders -ContentType 'application/json' -Body $recordBody
```

A replay with the same key and request returns the original status and response plus `Idempotency-Replayed: true`. Reusing the key for different content returns HTTP 409.

## Start the complete local stack

```powershell
docker compose up --build -d
```

Check the services:

```powershell
docker compose ps
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/docs-json
```

Open Swagger UI at `http://localhost:3000/docs`.

Stop the stack while preserving database and Redis volumes:

```powershell
docker compose down
```

Add `-v` only when you intend to delete local PostgreSQL and Redis data.

## Test the database schema

The integration suite creates a unique PostgreSQL schema, deploys the migrations twice, verifies the database objects and integrity rules, and removes the test schema afterward.

```powershell
docker compose up -d --wait postgres
npm run test:integration
```

Set `TEST_DATABASE_URL` when PostgreSQL is not available through the local Compose credentials. The suite falls back to `DATABASE_URL`, then to the local Compose URL.

## Local quality checks

```powershell
npm run prisma:validate
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
docker compose config
```

## Repository structure

```text
apps/api                              HTTP API and health endpoint
apps/api/src/blocking                 Internal bounded candidate generation
apps/worker                           BullMQ worker process
packages/contracts                    DTOs and public contract types
packages/config                       Environment validation
packages/database                     Prisma client and schema
packages/database/prisma/migrations   Ordered PostgreSQL migrations
packages/normalization                Pure, versioned field and record normalization
tests/integration                     Migration, API, isolation, blocking-plan, and concurrency tests
tests/fixtures                        Version-controlled integration input and expected data
tests/golden-dataset                  Labeled resolution examples
docs                                  Architecture and policy references
```

Read `AGENTS.md` before changing code. It contains the repository engineering rules.
