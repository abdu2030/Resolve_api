# Run Resolve from a fresh clone

## Start with Docker Compose

Install Git and Docker with Compose v2. The client example uses Node.js 24 or
newer. The Compose stack builds and runs the API and worker without a host
npm install.

```text
git clone https://github.com/abdu2030/Resolve_api.git
cd Resolve_api
```

Copy the local configuration once.

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env`. Keep `.env` untracked and
leave existing configuration in place when returning to a checkout.

```text
docker compose up --build --wait
docker compose ps --all
```

Compose waits for PostgreSQL, then runs the `migrate` service to apply the
committed Prisma migrations. The API and worker start after that service
exits successfully and Redis is healthy. Expect `migrate` to show
`Exited (0)`, the API to be healthy, and the worker to be running.

The health, docs, and client commands use the default host port, 3000.
For parallel checkouts, give each stack its own project name with
`docker compose -p <name>` and assign distinct `API_PORT`, `POSTGRES_PORT`,
and `REDIS_HOST_PORT` values in its `.env`. Use the same project name for
subsequent commands. The containers use their internal service addresses.

## Check health and OpenAPI

- [Readiness probe](http://localhost:3000/health/ready) reports PostgreSQL and Redis.
- [Liveness probe](http://localhost:3000/health/live) checks the running API.
- [Swagger UI](http://localhost:3000/docs) lets you inspect and try API operations.
- [OpenAPI JSON](http://localhost:3000/docs-json) is the generated machine-readable contract.

For a local spec file, run `curl -fsS http://localhost:3000/docs-json -o resolve-openapi.json`.
In Windows PowerShell, use `curl.exe` or
`Invoke-WebRequest http://localhost:3000/docs-json -OutFile resolve-openapi.json`.
The [v1 contract](contracts/mvp-v1.md) documents scopes, idempotency,
resolution outcomes, pagination, and webhook delivery.

## Run the client example

Create a demo tenant and a key with the exact scopes the example needs.
The command prints the secret once.

```text
docker compose exec -T api node apps/api/dist/auth/bootstrap-api-key.js --tenant-name "Client example" --environment test --scopes sources:write,records:write,jobs:read,entities:read
```

In a dedicated PowerShell 7 terminal, enter the secret without echoing it.

```powershell
$env:RESOLVE_API_KEY = Read-Host -MaskInput 'Demo API key'
node examples/resolve-client.mjs
```

In a dedicated Bash terminal, use the following.

```bash
read -rsp "Demo API key: " RESOLVE_API_KEY
printf '\n'
export RESOLVE_API_KEY
node examples/resolve-client.mjs
```

Close the terminal when you finish to clear its environment. Use
`RESOLVE_BASE_URL` when the API listens elsewhere, for example
`http://127.0.0.1:33000`. The client registers two sources, submits
one record, repeats the same keyed request, and submits a second source
record through a batch. It polls for completion and reads the shared
canonical entity. Expect `NO_MATCH` for the first record, `AUTO_MATCH`
for the second, and two linked records. Every run uses new synthetic
record identifiers. Run the example against a demo tenant.

## Run Node.js on the host

This workflow uses Docker for PostgreSQL and Redis while running the API
and worker through Node.js 24 or newer. Start at the repository root with
the copied `.env`.

```text
npm ci
docker compose up -d --wait postgres redis
npm run prisma:migrate:deploy
npm run build
```

When host ports change, update the host-side `DATABASE_URL` and `REDIS_PORT`
to match. On Windows, use `npm.cmd` if PowerShell blocks the npm script.
Start the processes in separate terminals from the same checkout.

```text
node --env-file=.env apps/api/dist/main.js
node --env-file=.env apps/worker/dist/main.js
```

When the API runs on the host, create the demo key with
`npm run auth:bootstrap -- --tenant-name "Client example" --environment test --scopes sources:write,records:write,jobs:read,entities:read`.
Run the same client example against it.

## Migrations and shutdown

The Compose stack applies pending migrations during startup. To rerun
deployment explicitly against a running Compose database, use
`docker compose run --rm --build migrate`. For the host workflow, use
`npm run prisma:migrate:deploy`. A second deployment at the same revision
reports that no migrations are pending.

When developing a schema change, run
`npm run prisma:migrate:dev -- --name descriptive_name` against a development
database and commit the Prisma schema and migration together.

If startup fails, inspect `docker compose ps --all` and
`docker compose logs migrate api worker`. Fix the migration or connection
error and rerun `docker compose up --build --wait`. Shut down with
`docker compose down`, which preserves the database and Redis volumes.
