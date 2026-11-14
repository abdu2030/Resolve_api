# Test idempotency, concurrency, and worker recovery

## 1. Prepare the checkout

Open Docker Desktop, then run these commands in PowerShell from your main checkout.

```powershell
Set-Location -LiteralPath 'C:\Users\Admin\Desktop\Resolve Api'
docker compose up -d --wait --no-build --pull never postgres redis
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL or Redis could not start' }
$env:TEST_DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
```

These commands use the existing Node dependencies and Compose images.
Use `TEST_REDIS_HOST` and `TEST_REDIS_PORT` if your test Redis is elsewhere. The
tests run their own API and worker, create isolated schemas and queue keys, and
clean them up. The restart test launches and stops its own worker processes.

## 2. Check batch concurrency and worker recovery

```powershell
npm.cmd run test:integration -- --runTestsByPath tests/integration/week3-day1-batch.integration.ts
if ($LASTEXITCODE -ne 0) { throw 'Batch regression suite failed' }
```

Expect eight tests to pass. The new checks verify the following behavior:

1. Three requests wait on the same idempotency lock. The first two use the same
   body and receive `202` with one job ID. The replay has the replay header.
   The different body receives `409`. PostgreSQL contains one job item and one
   idempotency response for the accepted batch.
2. A worker and a direct HTTP request wait on the same source record lock.
   The worker creates the record. HTTP reports `UNCHANGED` with the same record
   and entity IDs. PostgreSQL contains one source version, one entity link, and
   one canonical snapshot for that record.
3. After the first record commits, the test kills the worker while the second
   record is blocked. PostgreSQL shows one processed item. A new worker recovers
   the stalled BullMQ job, retains the first result, and finishes the second
   record in attempt two. BullMQ's lock expiration and stalled checks can take
   about a minute.

The suite also checks transient retries after partial success, retry exhaustion,
tenant isolation, and continuation after a permanent record conflict.

## 3. Check direct-ingestion races and overlapping merges

```powershell
npm.cmd run test:integration -- --runTestsByPath tests/integration/day4-api.integration.ts tests/integration/week2-day5-entity-operations.integration.ts
if ($LASTEXITCODE -ne 0) { throw 'Ingestion or merge regression suite failed' }
```

Expect concurrent direct uploads to create one source record and version.
Concurrent requests with the same explicit key preserve one replay response.
For overlapping merges, one succeeds and the other gets `409 ENTITY_NOT_ACTIVE`.
The successful operation records the actor, affected link, and two canonical
snapshots. Replaying the winning request returns its original response.
