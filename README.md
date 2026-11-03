# Resolve API

Resolve links imperfect Person and Company records to stable canonical entities. It preserves source truth and produces explainable, versioned, reversible identity decisions.

## Current milestone

Week 2 Day 7 runs all eight golden pairs through the authenticated HTTP resolver
against PostgreSQL and reports precision, automatic-match recall, false positives,
review rate, automatic resolution, and positive candidate recall. Run
`npm run evaluate:golden`; see the
[Day 7 evaluation and PowerShell testing guide](docs/testing/week2-day7-quality-powershell.md)
for setup, metric definitions, the measured baseline, and the known blocking miss.
Identity labels describe authored synthetic scenarios separately from policy
expectations. Scoring weights, thresholds, and algorithm versions are unchanged.

Week 2 Day 6 adds review listing/evidence inspection and transactional
approve/reject decisions with immutable human outcomes. Approval links the
record to the proposed entity; rejection creates a separate entity. Both
preserve machine evidence and record actor/reason and canonical history.
See the [Day 6 PowerShell testing guide](docs/testing/week2-day6-reviews-powershell.md)
for setup commands, review requests, and detailed expected results.
Review reads require `reviews:read`; decisions require `reviews:write` and
Idempotency-Key. Existing API keys need the new scopes; bootstrap defaults now
include all seven supported scopes. Matching weights/thresholds remain unchanged.

Week 1 Days 1-7 provide the repository foundation, locked MVP contracts, NestJS application shells, PostgreSQL and Redis infrastructure, tenant API-key authentication, source registration, raw record ingestion, deterministic Person/Company normalization, bounded candidate blocking, and a realistic integration checkpoint. Week 2 Days 1-5 add deterministic comparison, `features-v1` extraction, versioned `rules-0.1.0` scoring, the live resolver pipeline, `canonicalization-v1` survivorship, field provenance, immutable canonical history, tenant-scoped entity reads, and safe manual merge, selected-record split, and explicit merge reversal.

Follow the
[step-by-step PowerShell merge/split testing guide](docs/testing/week2-day5-merge-split-powershell.md)
from your checkout for setup, migrations, action scopes, merge, replay, source
updates, exact reversal, selected split, denial checks, and SQL preservation checks.

The API stores each source record under a stable tenant/source/external identity. Changed payloads create immutable history rows; identical retries create no new raw version. Each accepted record stores separate `normalization-v1` payload and indexed projections while preserving the submitted source data. In the same transaction, `blocking-v1` retrieves only tenant-local, same-type linked entity candidates, the matching package compares and scores every supporting record, and the resolver returns an explainable three-way decision. `AUTO_MATCH` links the record to one existing entity, `NO_MATCH` creates and links a new entity, and `REVIEW` creates an open review case without linking the incoming record.

Accepted links synchronously canonicalize in that transaction. For each field,
survivorship prefers lower source priority, greater completeness, newer record
update time, then the smaller record ID. Canonical changes retain their winning
source provenance and append a snapshot. Raw records remain separate. `REVIEW`
does not canonicalize, and unchanged positive-version ingestion creates no new
canonical history. See [the API contract](docs/contracts/mvp-v1.md) for exact
fields, pagination, legacy version-zero behavior, and error semantics.

## Architecture

Resolve is an npm-workspaces modular monolith. The NestJS API handles HTTP and readiness, the NestJS worker hosts BullMQ background processing, PostgreSQL is durable storage, and Redis provides queue and coordination infrastructure. Shared contracts, configuration, Prisma access, pure normalization rules, and pure matching evidence live in focused packages. See `docs/architecture/overview.md` for the process boundaries, comparator formulas, and persistence model.

## Matching evidence

`@resolve/matching` is a deterministic, side-effect-free package. It consumes two same-type records that have already passed through `normalizeRecord`, emits `features-v1` evidence, and applies the versioned `rules-0.1.0` scorer. The scorer returns confidence, `AUTO_MATCH`, `REVIEW`, or `NO_MATCH`, a copy of its inputs, and a contribution-level explanation.

The scorer renormalizes weights across available positive evidence, subtracts `0.15` per warning contradiction, clamps confidence to `0..1`, and prevents blocking contradictions from producing `AUTO_MATCH`. PostgreSQL stores candidate evidence in the tenant-scoped `match_features` table. If more than one entity reaches `AUTO_MATCH`, the resolver safely returns `REVIEW` with a blocking ambiguity contradiction.

Run the matching package tests, including golden evidence coverage, with:

```powershell
npm run test -- packages/matching/test
```

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
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path node_modules)) { npm ci }
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

The command prints the tenant ID, API-key ID, and plaintext key. Copy the plaintext key when it appears; PostgreSQL stores only its SHA-256 hash. The default key has `sources:write`, `records:write`, `entities:read`, `entities:merge`, `entities:split`, `reviews:read`, and `reviews:write` scopes. Use `--scopes records:write` or `--key-name "Importer"` when you need a narrower key or a descriptive name. Existing keys are not upgraded automatically. Each bootstrap invocation creates a new tenant and key; it does not add a key to a previously created tenant.

## Manual canonicalization validation in PowerShell

Run the numbered steps in order. This walkthrough starts the API from this
checkout while Compose supplies PostgreSQL and Redis. Use a fresh demo tenant
and the generated suffix on each run so existing demo records cannot affect
matching. Commands below contain placeholder API keys only. Do not paste real
keys or raw customer responses into shared logs.

### 1. Prepare the checkout, dependencies, and local stack

```powershell
$resolveCheckout = 'C:\Users\Admin\Desktop\Resolve Api'
Set-Location $resolveCheckout # Substitute your checkout path if different.
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path node_modules)) { npm ci }
# If a normal installation is incomplete, restore dependencies with npm ci.
npm run prisma:generate
docker compose up -d --wait postgres redis
npm run prisma:validate
npm run prisma:migrate:deploy
npm run build
```

The provided `.env.example` uses local development credentials. Existing `.env`
files are preserved; confirm their database and Redis settings match the local
stack. Do not run another API on port 3000. In a second PowerShell terminal,
start this checkout's built API with the root environment explicitly loaded
(npm workspace scripts otherwise run from the package directory):

```powershell
$resolveCheckout = 'C:\Users\Admin\Desktop\Resolve Api'
Set-Location $resolveCheckout
node --env-file=.env apps/api/dist/main.js
```

Keep that terminal running. Back in the first terminal:

```powershell
$resolveBaseUrl = 'http://localhost:3000'
Invoke-RestMethod "$resolveBaseUrl/health"
# Swagger: http://localhost:3000/docs; JSON: http://localhost:3000/docs-json
$resolveRun = [guid]::NewGuid().ToString('N').Substring(0, 12)
npm run auth:bootstrap -- --tenant-name "Canonical demo $resolveRun" `
  --environment test --scopes sources:write,records:write,entities:read
$resolveApiKey = 'rslv_test_replace_with_demo_key'
$resolveHeaders = @{ Authorization = "Bearer $resolveApiKey" }
```

Replace `$resolveApiKey` with the key shown once by bootstrap. Expected health
is successful; bootstrap's scopes include the new `entities:read` permission.

### 2. Register sources with different authority

```powershell
$resolveCsvName = "csv_$resolveRun"
$resolveCrmName = "crm_$resolveRun"
$resolveCsvBody = @{ name = $resolveCsvName; type = 'csv'; priority = 100 } | ConvertTo-Json
$resolveCrmBody = @{ name = $resolveCrmName; type = 'api'; priority = 10 } | ConvertTo-Json
$resolveCsv = Invoke-RestMethod -Method Post -Uri "$resolveBaseUrl/v1/sources" `
  -Headers $resolveHeaders -ContentType 'application/json' -Body $resolveCsvBody
$resolveCrm = Invoke-RestMethod -Method Post -Uri "$resolveBaseUrl/v1/sources" `
  -Headers $resolveHeaders -ContentType 'application/json' -Body $resolveCrmBody
$resolveCsv | Select-Object source_id, name, type, priority
$resolveCrm | Select-Object source_id, name, type, priority
```

Expect priorities `100` and `10`. Lower is more authoritative. Priority defaults
to `100` when omitted and must be an integer `0..1000`. Source names and types
are lowercase slugs. Repeating either exact body returns the existing source;
changing its effective priority returns `409 SOURCE_PRIORITY_CONFLICT`, and
changing its type returns `409 SOURCE_TYPE_CONFLICT`.

### 3. Ingest two records for the same person

All five scoring groups agree in these fixtures: email, phone, name, company,
and location. The first record establishes the entity; the second has enough
evidence to automatically link and higher source authority to demonstrate
survivorship.

```powershell
$resolveEmail = "abdul.$resolveRun@example.com"
$resolveCsvRecord = @{
  source = $resolveCsvName
  external_id = "row-$resolveRun"
  entity_type = 'person'
  data = @{
    name = 'ABDULKERIM HASSEN'; email = $resolveEmail; phone = '0911 223 344'
    company = 'RESOLVE API'; company_domain = 'resolve.example'
    address = @{ line1 = '10 AFRICA AVENUE'; city = 'ADDIS ABABA'; country = 'ET' }
  }
}
$resolveCrmRecord = @{
  source = $resolveCrmName
  external_id = "contact-$resolveRun"
  entity_type = 'person'
  data = @{
    name = '  Abdulkerim   Hassen  '; email = $resolveEmail; phone = '+251 911 223 344'
    company = 'Resolve API'; company_domain = 'resolve.example'
    address = @{ line1 = '10 Africa Avenue'; city = 'Addis Ababa'; country = 'et' }
  }
}
$resolveCsvJson = $resolveCsvRecord | ConvertTo-Json -Depth 10
$resolveCrmJson = $resolveCrmRecord | ConvertTo-Json -Depth 10
$resolveFirst = Invoke-RestMethod -Method Post -Uri "$resolveBaseUrl/v1/records" `
  -Headers $resolveHeaders -ContentType 'application/json' -Body $resolveCsvJson
$resolveIdempotentHeaders = @{
  Authorization = "Bearer $resolveApiKey"
  'Idempotency-Key' = "crm-create-$resolveRun"
}
$resolveSecond = Invoke-RestMethod -Method Post -Uri "$resolveBaseUrl/v1/records" `
  -Headers $resolveIdempotentHeaders -ContentType 'application/json' -Body $resolveCrmJson
$resolveFirst | Select-Object record_id, entity_id, entity_type, operation, version, decision
$resolveSecond | Select-Object record_id, entity_id, entity_type, operation, version, decision, confidence
$entityId = $resolveFirst.entity_id
if ($resolveSecond.entity_id -ne $entityId -or $resolveSecond.decision -ne 'AUTO_MATCH') {
  throw 'Expected both records to resolve to the same entity with AUTO_MATCH on the second.'
}
```

Expect `entity_type: person`, `operation: CREATED`, and raw `version: 1` for
both; first decision `NO_MATCH`, second `AUTO_MATCH` with confidence `1`.
`entity_id` is shared. Decisions remain uppercase; public entity types are
lowercase `person`/`company`.

### 4. Read canonical state, linked raw records, and history

```powershell
$resolveEntity = Invoke-RestMethod "$resolveBaseUrl/v1/entities/$entityId" -Headers $resolveHeaders
$resolveRecords = Invoke-RestMethod "$resolveBaseUrl/v1/entities/$entityId/records" -Headers $resolveHeaders
$resolveHistory = Invoke-RestMethod "$resolveBaseUrl/v1/entities/$entityId/history" -Headers $resolveHeaders
$resolveEntity | ConvertTo-Json -Depth 20
$resolveRecords | ConvertTo-Json -Depth 20
$resolveHistory | ConvertTo-Json -Depth 20
```

Expect `canonical_version: 2`, `canonicalization_version: canonicalization-v1`,
and `record_count: 2`. `canonical_data.name` is `Abdulkerim Hassen`;
`canonical_data.phone` is `+251911223344`. `provenance.name` identifies the CRM
record with `source_priority: 10`, `selection_rule: SOURCE_PRIORITY`, and its
original whitespace-bearing `raw_value`. `provenance.address` is nested by
component. Record-page `items` include `raw_payload`, `normalized_payload`,
`source.priority`, and `link` evidence. The original CSV and CRM values remain
visible. History `items` descend from version 2 (`RECORD_LINKED`) to version 1
(`ENTITY_CREATED`), each with canonical data, provenance, policy, and trigger.

### 5. Verify idempotent replay creates no canonical history

```powershell
$resolveBeforeVersion = $resolveEntity.canonical_version
$resolveBeforeHistoryCount = @($resolveHistory.items).Count
$resolveReplay = Invoke-WebRequest -UseBasicParsing -Method Post `
  -Uri "$resolveBaseUrl/v1/records" -Headers $resolveIdempotentHeaders `
  -ContentType 'application/json' -Body $resolveCrmJson
$resolveReplay.Headers['Idempotency-Replayed'] # true
$resolveReplay.Content | ConvertFrom-Json | Select-Object operation, version, entity_id
# Without an Idempotency-Key, identical logical input returns UNCHANGED.
$resolveUnchanged = Invoke-RestMethod -Method Post -Uri "$resolveBaseUrl/v1/records" `
  -Headers $resolveHeaders -ContentType 'application/json' -Body $resolveCrmJson
$resolveAfter = Invoke-RestMethod "$resolveBaseUrl/v1/entities/$entityId" -Headers $resolveHeaders
$resolveAfterHistory = Invoke-RestMethod "$resolveBaseUrl/v1/entities/$entityId/history" -Headers $resolveHeaders
if ($resolveUnchanged.operation -ne 'UNCHANGED' -or
    $resolveAfter.canonical_version -ne $resolveBeforeVersion -or
    @($resolveAfterHistory.items).Count -ne $resolveBeforeHistoryCount) {
  throw 'Replay unexpectedly changed canonical state or history.'
}
```

The keyed replay returns its original `CREATED` response and raw version 1;
the unkeyed replay returns `UNCHANGED`. Both preserve canonical version 2 and
two history rows. Reusing that key with different content returns `409`.

### 6. Update a linked record and page through both collections

Submit changed content without the old idempotency key:

```powershell
$resolveCrmRecord.data.name = 'Abdulkerim Hassen Ali'
$resolveUpdatedJson = $resolveCrmRecord | ConvertTo-Json -Depth 10
$resolveUpdated = Invoke-RestMethod -Method Post -Uri "$resolveBaseUrl/v1/records" `
  -Headers $resolveHeaders -ContentType 'application/json' -Body $resolveUpdatedJson
$resolveUpdated | Select-Object operation, version, entity_id
$resolveUpdatedEntity = Invoke-RestMethod "$resolveBaseUrl/v1/entities/$entityId" -Headers $resolveHeaders
$resolveUpdatedHistory = Invoke-RestMethod "$resolveBaseUrl/v1/entities/$entityId/history" -Headers $resolveHeaders
$resolveUpdatedEntity | Select-Object canonical_version, canonical_data
$resolveUpdatedHistory.items | Select-Object version, trigger
foreach ($resolveCollection in @('records', 'history')) {
  $resolvePageUri = "$resolveBaseUrl/v1/entities/$entityId/${resolveCollection}?limit=1"
  do {
    $resolvePage = Invoke-RestMethod $resolvePageUri -Headers $resolveHeaders
    $resolvePage.items | ConvertTo-Json -Depth 20
    $resolveCursor = $resolvePage.next_cursor
    if ($null -ne $resolveCursor) {
      $resolveEncodedCursor = [uri]::EscapeDataString($resolveCursor)
      $resolvePageUri = "$resolveBaseUrl/v1/entities/$entityId/${resolveCollection}?limit=1&cursor=$resolveEncodedCursor"
    }
  } while ($null -ne $resolveCursor)
}
```

Expect `UPDATED`, raw version `2`, the same entity, canonical version `3`, the
new name, and a newest `RECORD_UPDATED` snapshot. Prior raw and canonical
versions remain preserved. Records yield two items across two pages; history
yields three items across three pages. Default limit is 25; valid limits are
1 through 100. Each collection has its own opaque cursor; the last page has
`next_cursor: null`. Invalid UUIDs, limits, and malformed/empty cursors return
`400`.

### 7. Check foreign-tenant and missing-scope denial

Create two additional demo credentials. Each bootstrap creates its own tenant;
the foreign key has read scope, while the restricted key deliberately lacks it.

```powershell
npm run auth:bootstrap -- --tenant-name "Foreign reader $resolveRun" `
  --environment test --scopes entities:read
npm run auth:bootstrap -- --tenant-name "Restricted writer $resolveRun" `
  --environment test --scopes records:write
$resolveForeignApiKey = 'rslv_test_replace_with_foreign_reader_key'
$resolveRestrictedApiKey = 'rslv_test_replace_with_restricted_writer_key'
$resolveForeignHeaders = @{ Authorization = "Bearer $resolveForeignApiKey" }
$resolveRestrictedHeaders = @{ Authorization = "Bearer $resolveRestrictedApiKey" }
foreach ($resolveSuffix in @('', '/records', '/history')) {
  foreach ($resolveCheck in @(
    @{ Headers = $resolveForeignHeaders; Expected = 404 },
    @{ Headers = $resolveRestrictedHeaders; Expected = 403 }
  )) {
    try {
      $null = Invoke-RestMethod "$resolveBaseUrl/v1/entities/$entityId$resolveSuffix" `
        -Headers $resolveCheck.Headers
      throw 'Expected authorization denial, but the request succeeded.'
    } catch {
      if ($null -eq $_.Exception.Response) { throw }
      $resolveStatus = [int]$_.Exception.Response.StatusCode
      if ($resolveStatus -ne $resolveCheck.Expected) { throw }
      "Expected denial: HTTP $resolveStatus on $resolveSuffix"
    }
  }
}
```

All three routes return `404 ENTITY_NOT_FOUND` to the foreign reader and
`403` to the key without `entities:read`. Missing, invalid, and revoked keys
return `401`. Tenant identity is never supplied in a request body or query.

### 8. Optional local database inspection and shutdown

For the default Compose database credentials, inspect only this demo entity:

```powershell
docker compose exec -T postgres psql -U resolve -d resolve -c "SELECT id, canonical_version, canonical_data FROM entities WHERE id = '$entityId'::uuid;"
docker compose exec -T postgres psql -U resolve -d resolve -c "SELECT field_path, source_record_id, source_priority, selection_rule, canonicalization_version FROM entity_field_provenance WHERE entity_id = '$entityId'::uuid ORDER BY field_path;"
docker compose exec -T postgres psql -U resolve -d resolve -c "SELECT version, trigger_operation, canonicalization_version FROM entity_canonical_versions WHERE entity_id = '$entityId'::uuid ORDER BY version DESC;"
docker compose exec -T postgres psql -U resolve -d resolve -c "SELECT v.source_record_id, v.version, v.raw_payload FROM source_record_versions v JOIN entity_record_links l ON l.tenant_id = v.tenant_id AND l.source_record_id = v.source_record_id WHERE l.entity_id = '$entityId'::uuid ORDER BY v.source_record_id, v.version;"
```

Expect canonical version 3, three snapshots, current field provenance, and
three raw versions across the two records. Adjust credentials/schema only for
your local configuration. SQL inspection bypasses API authorization and is
for local development only. Stop the API with Ctrl+C in its terminal, then
`docker compose stop postgres redis` to preserve local data.

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
packages/matching                     Pure comparators and features-v1 evidence extraction
tests/integration                     Migration, API, isolation, blocking-plan, and concurrency tests
tests/fixtures                        Version-controlled integration input and expected data
tests/golden-dataset                  Labeled resolution examples
docs                                  Architecture and policy references
```

Read `AGENTS.md` before changing code. It contains the repository engineering rules.
