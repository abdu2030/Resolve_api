# Resolve API

Resolve links imperfect Person and Company records to stable canonical entities. It preserves source truth and produces explainable, versioned, reversible identity decisions.

## Current milestone

Week 1 Days 1-3 provide the repository foundation, MVP contracts, golden dataset, NestJS API and worker shells, PostgreSQL and Redis infrastructure, and the foundational multi-tenant database schema.

The database now stores tenants, API key metadata, source systems, immutable source records, canonical entities, and explicit entity-record links. Authentication, record-ingestion endpoints, normalization services, and matching behavior remain for later roadmap days.

## Architecture

Resolve is an npm-workspaces modular monolith. The NestJS API handles HTTP and readiness, the NestJS worker hosts BullMQ background processing, PostgreSQL is durable storage, and Redis provides queue and coordination infrastructure. Shared contracts, configuration, and Prisma access live in focused packages. See `docs/architecture/overview.md` for the process boundaries and persistence model.

## Environment variables

| Variable             | Purpose                                                | Example/default                     |
| -------------------- | ------------------------------------------------------ | ----------------------------------- |
| `NODE_ENV`           | Runtime mode: `development`, `test`, or `production`   | `development`                       |
| `API_PORT`           | Host port used by the API                              | `3000`                              |
| `DATABASE_URL`       | PostgreSQL connection string used by Prisma            | Local Compose URL in `.env.example` |
| `TEST_DATABASE_URL`  | Optional URL used by database integration tests        | `DATABASE_URL`, then local Compose  |
| `REDIS_HOST`         | Redis hostname                                         | `localhost`                         |
| `REDIS_PORT`         | Redis port                                             | `6379`                              |
| `REQUEST_BODY_LIMIT` | Maximum JSON request body size                         | `1mb`                               |
| `POSTGRES_DB`        | Compose PostgreSQL database name                       | `resolve`                           |
| `POSTGRES_USER`      | Compose PostgreSQL user                                | `resolve`                           |
| `POSTGRES_PASSWORD`  | Compose PostgreSQL password for local development only | `resolve`                           |

The application validates its six runtime variables at startup and reports only the invalid variable name, never its value.

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
apps/worker                           BullMQ worker process
packages/contracts                    DTOs and public contract types
packages/config                       Environment validation
packages/database                     Prisma client and schema
packages/database/prisma/migrations   Ordered PostgreSQL migrations
tests/integration                     Database migration and constraint tests
tests/golden-dataset                  Labeled resolution examples
docs                                  Architecture and policy references
```

Read `AGENTS.md` before changing code. It contains the repository engineering rules.
