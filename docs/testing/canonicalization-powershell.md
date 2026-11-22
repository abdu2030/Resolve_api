# Canonicalization walkthrough (PowerShell)

Run the numbered steps in order. This walkthrough starts the API from this
checkout while Compose supplies PostgreSQL and Redis. Use a fresh demo tenant
and the generated suffix on each run so existing demo records cannot affect
matching. Commands below contain placeholder API keys only. Do not paste real
keys or raw customer responses into shared logs.

## 1. Prepare the checkout, dependencies, and local stack

```powershell
# Run from the repository root.
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
# Run from the repository root.
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

Replace `$resolveApiKey` with the key shown once by bootstrap. The key includes
`entities:read` for the canonical entity lookups below.

## 2. Register sources with different authority

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

## 3. Ingest two records for the same person

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

## 4. Read canonical state, linked raw records, and history

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

## 5. Verify idempotent replay creates no canonical history

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

## 6. Update a linked record and page through both collections

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

## 7. Check foreign-tenant and missing-scope denial

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

## 8. Optional local database inspection and shutdown

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
