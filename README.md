# Resolve API

Resolve links imperfect Person and Company records to stable canonical entities. It preserves source truth and produces explainable, versioned, reversible identity decisions.

## Current milestone

Week 1 Days 1-2 provide the repository foundation, MVP contracts, golden dataset, NestJS API and worker shells, Prisma, PostgreSQL, Redis, BullMQ wiring, Swagger, and readiness checks.

This milestone does not persist records or perform entity resolution. Week 1 Days 3-7 add the first schema, authentication, ingestion, normalization, and blocking behavior.

## Architecture

Resolve is an npm-workspaces modular monolith. The NestJS API handles HTTP and readiness, the NestJS worker hosts BullMQ background processing, PostgreSQL is durable storage, and Redis provides queue and coordination infrastructure. Shared contracts, configuration, and Prisma access live in focused packages. See `docs/architecture/overview.md` for the process boundaries and future resolution flow.

## Environment variables

| Variable             | Purpose                                                | Example/default                     |
| -------------------- | ------------------------------------------------------ | ----------------------------------- |
| `NODE_ENV`           | Runtime mode: `development`, `test`, or `production`   | `development`                       |
| `API_PORT`           | Host port used by the API                              | `3000`                              |
| `DATABASE_URL`       | PostgreSQL connection string used by Prisma            | Local Compose URL in `.env.example` |
| `REDIS_HOST`         | Redis hostname                                         | `localhost`                         |
| `REDIS_PORT`         | Redis port                                             | `6379`                              |
| `REQUEST_BODY_LIMIT` | Maximum JSON request body size                         | `1mb`                               |
| `POSTGRES_DB`        | Compose PostgreSQL database name                       | `resolve`                           |
| `POSTGRES_USER`      | Compose PostgreSQL user                                | `resolve`                           |
| `POSTGRES_PASSWORD`  | Compose PostgreSQL password for local development only | `resolve`                           |

Every variable is represented in `.env.example`. The application validates its six runtime variables at startup and reports only the invalid variable name, never its value.

## Prerequisites

- Node.js 24 or newer
- npm 11 or newer
- Docker Desktop with Docker Compose
- Git

## Install

PowerShell:

```powershell
Copy-Item .env.example .env
npm install
npm run prisma:generate
```

The `.env` file stays untracked. Change its development credentials if other users can access your machine.

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

## Local quality checks

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
docker compose config
```

## Repository structure

```text
apps/api                 HTTP API and health endpoint
apps/worker              BullMQ worker process
packages/contracts       DTOs and public contract types
packages/config          Environment validation
packages/database        Prisma client and schema
tests/golden-dataset     Labeled resolution examples
docs                     Architecture and policy references
```

Read `AGENTS.md` before changing code. It contains the repository engineering rules.
