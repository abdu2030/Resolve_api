# Week 2 Day 5: manual merge, split, and reversal checks

Run the numbered steps in order with **PowerShell 7**, Node.js 24+, npm 11+,
and Docker Desktop. Commands target disposable demo records in your local
Compose database. Use only generated demo credentials/data. Keep API keys in
your terminal; do not put them in shared transcripts or source files.

Use the checkout containing the Day 5 implementation. The commands below use
`C:\Users\Admin\Desktop\Resolve Api`; adjust this path if your checkout is elsewhere.
Use the same checkout in both terminals. No worker is needed for synchronous operations.

## 1. Prepare, migrate, and build the checkout

```powershell
$resolveCheckout = 'C:\Users\Admin\Desktop\Resolve Api'
Set-Location -LiteralPath $resolveCheckout
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path node_modules)) { npm.cmd ci }
# Existing .env files and installed dependency junctions are preserved.
$env:DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
docker compose up -d --wait postgres redis
npm.cmd run prisma:validate
npm.cmd run prisma:migrate:deploy
npm.cmd run prisma:migrate:deploy
npm.cmd run build
```

Stop if any command exits nonzero. The second deploy must report no pending
migrations. The URL above is for the supplied local Compose credentials;
adjust it if you deliberately changed those credentials. Migration deploy
preserves existing data; do not reset your database or remove Compose volumes.
The build generates Prisma and compiles all workspaces. On this prepared
machine installed dependencies are reused; a fresh checkout needs `npm.cmd ci`.

In a **second PowerShell terminal**, start the built API:

```powershell
Set-Location -LiteralPath 'C:\Users\Admin\Desktop\Resolve Api'
$env:DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
$env:API_PORT = '3000'
node --env-file=.env apps/api/dist/main.js
```

Keep it running. Port 3000 must be free of any older API process. Environment
variables in this terminal override `.env` values. In the **first terminal**:

```powershell
$resolveBaseUrl = 'http://localhost:3000'
Invoke-RestMethod "$resolveBaseUrl/health"
# Swagger: http://localhost:3000/docs
# OpenAPI JSON: http://localhost:3000/docs-json
$resolveRun = [guid]::NewGuid().ToString('N').Substring(0, 12)
npm.cmd run auth:bootstrap -- --tenant-name "Day5 demo $resolveRun" `
  --environment test `
  --scopes sources:write,records:write,entities:read,entities:merge,entities:split
$resolveTenantId = 'REPLACE_WITH_TENANT_UUID'
$resolveApiKeyId = 'REPLACE_WITH_API_KEY_UUID'
$resolveApiKey = 'rslv_test_REPLACE_WITH_SHOWN_KEY'
$resolveHeaders = @{ Authorization = "Bearer $resolveApiKey" }
```

Expected: health returns 200. Copy all three bootstrap values into the
placeholders. Plaintext is shown once; only its hash is stored. Bootstrap
creates a fresh tenant each time; it cannot add a key to an existing tenant.
Existing keys do not gain action scopes automatically.

Define these helpers once. They retain status/header/body data so replay and
denial checks do not depend on exception handling:

```powershell
function Invoke-ResolvePost {
  param([string]$Path, [object]$Body, [string]$Key,
    [hashtable]$Auth = $resolveHeaders)
  $headers = @{} + $Auth
  if ($Key) { $headers['Idempotency-Key'] = $Key }
  $response = Invoke-WebRequest -Method Post -Uri "$resolveBaseUrl$Path" `
    -Headers $headers -ContentType 'application/json' `
    -Body ($Body | ConvertTo-Json -Depth 30) -SkipHttpErrorCheck
  [pscustomobject]@{
    Status = [int]$response.StatusCode
    Headers = $response.Headers
    Body = ($response.Content | ConvertFrom-Json)
  }
}
function Get-ResolveEntity([string]$Id) {
  Invoke-RestMethod "$resolveBaseUrl/v1/entities/$Id" -Headers $resolveHeaders
}
function Assert-Resolve([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
function Invoke-ResolveSql([string]$Sql) {
  $result = $Sql | docker compose exec -T postgres psql -U resolve -d resolve `
    -v ON_ERROR_STOP=1 -X -A -t
  if ($LASTEXITCODE -ne 0) { throw 'Demo SQL inspection failed' }
  $result -join "`n"
}
```

SQL below assumes the local `public` schema. It reads only the generated
tenant. API-returned UUIDs are used in inspection queries; never substitute
untrusted input. If you changed Compose credentials/database, adjust the helper.

## 2. Register sources and create deliberately distinct entities

```powershell
$resolveSourceA = "manual_a_$resolveRun"
$resolveSourceB = "manual_b_$resolveRun"
$sourceA = Invoke-ResolvePost '/v1/sources' @{
  name = $resolveSourceA; type = 'api'; priority = 100
}
$sourceB = Invoke-ResolvePost '/v1/sources' @{
  name = $resolveSourceB; type = 'csv'; priority = 10
}
Assert-Resolve ($sourceA.Status -eq 201 -and $sourceB.Status -eq 201) 'Source creation failed'
$resolveRecordA = @{
  source = $resolveSourceA; external_id = "alpha-$resolveRun"; entity_type = 'person'
  data = @{ name = 'Marta Kebede'; email = "marta.$resolveRun@example.com" }
}
$resolveRecordB = @{
  source = $resolveSourceB; external_id = "bravo-$resolveRun"; entity_type = 'person'
  data = @{ name = 'Solomon Bekele'; email = "solomon.$resolveRun@example.net" }
}
$a = Invoke-ResolvePost '/v1/records' $resolveRecordA "ingest-a-$resolveRun"
$b = Invoke-ResolvePost '/v1/records' $resolveRecordB "ingest-b-$resolveRun"
Assert-Resolve ($a.Status -eq 201 -and $b.Status -eq 201) 'Ingestion failed'
Assert-Resolve ($a.Body.decision -eq 'NO_MATCH' -and $b.Body.decision -eq 'NO_MATCH') 'Fixtures matched unexpectedly'
$resolveTargetId = $a.Body.entity_id
$resolveSourceId = $b.Body.entity_id
$resolveMovedRecordId = $b.Body.record_id
Assert-Resolve ($resolveTargetId -ne $resolveSourceId) 'Expected two different entities'
$targetBefore = Get-ResolveEntity $resolveTargetId
$sourceBefore = Get-ResolveEntity $resolveSourceId
$targetBefore | ConvertTo-Json -Depth 20
$sourceBefore | ConvertTo-Json -Depth 20
```

Expected: two ACTIVE entities, one record each, canonical version 1. These
records have distinct blocking signals and deliberately different identities;
the manual action demonstrates mechanics, not a suggested matching decision.
Source B has priority 10, so its present fields will win after manual merging.

Capture immutable evidence before moving links. This excludes the link's
mutable entity/last-operation/update columns, but includes its original ID,
creation time, decision, score, policy, and explanation. The captured raw
versions must remain identical through merge and replay:

```powershell
$resolvePreservationSql = @"
SELECT jsonb_build_object(
  'records', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
    FROM public.source_records r WHERE r.tenant_id = '$resolveTenantId'),
  'raw_versions', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id)
    FROM public.source_record_versions v WHERE v.tenant_id = '$resolveTenantId'),
  'links', (SELECT jsonb_agg(to_jsonb(l) - 'entity_id' - 'last_entity_operation_id' - 'updated_at' ORDER BY l.id)
    FROM public.entity_record_links l WHERE l.tenant_id = '$resolveTenantId'),
  'features', (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id)
    FROM public.match_features f WHERE f.tenant_id = '$resolveTenantId'),
  'reviews', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
    FROM public.review_cases c WHERE c.tenant_id = '$resolveTenantId')
);
"@
$resolveEvidenceBefore = Invoke-ResolveSql $resolvePreservationSql
$resolveOldSnapshots = Invoke-ResolveSql @"
SELECT jsonb_agg(to_jsonb(v) ORDER BY v.entity_id, v.version)
FROM public.entity_canonical_versions v
WHERE v.tenant_id = '$resolveTenantId' AND v.version = 1;
"@
```

## 3. Merge source B into target A and inspect both stable IDs

```powershell
$resolveMergeBody = @{
  source_entity_id = $resolveSourceId
  expected_source_version = $sourceBefore.canonical_version
  expected_target_version = $targetBefore.canonical_version
  reason = 'Demo: explicit manual merge'
}
$resolveMergeKey = "merge-$resolveRun"
$merge = Invoke-ResolvePost "/v1/entities/$resolveTargetId/merge" $resolveMergeBody $resolveMergeKey
Assert-Resolve ($merge.Status -eq 200 -and $merge.Body.operation -eq 'MERGE') 'Merge failed'
$resolveMergeEventId = $merge.Body.operation_id
$merge.Body | ConvertTo-Json -Depth 20
$mergedTarget = Get-ResolveEntity $resolveTargetId
$mergedSource = Get-ResolveEntity $resolveSourceId
$mergedTarget | ConvertTo-Json -Depth 20
$mergedSource | ConvertTo-Json -Depth 20
foreach ($id in @($resolveTargetId, $resolveSourceId)) {
  Invoke-RestMethod "$resolveBaseUrl/v1/entities/$id/records?limit=100" `
    -Headers $resolveHeaders | ConvertTo-Json -Depth 30
  Invoke-RestMethod "$resolveBaseUrl/v1/entities/$id/history?limit=100" `
    -Headers $resolveHeaders | ConvertTo-Json -Depth 30
}
Assert-Resolve ($mergedTarget.record_count -eq 2 -and $mergedTarget.canonical_version -eq 2) 'Target projection mismatch'
Assert-Resolve ($mergedSource.status -eq 'MERGED' -and $mergedSource.record_count -eq 0) 'Source shell mismatch'
Assert-Resolve ($mergedSource.merged_into_entity_id -eq $resolveTargetId) 'Stable source target mismatch'
Assert-Resolve ((Invoke-ResolveSql $resolvePreservationSql) -eq $resolveEvidenceBefore) 'Source truth or original evidence changed'
```

Expected: target ACTIVE/version 2 with B's name/email and provenance pointing
to B's record/source; source MERGED/version 2 with `{}` canonical data and
provenance. Both histories retain version 1 and add a MERGE snapshot.
`trigger.entity_operation_id` and the full `entity_operation` audit object
identify the same event on both histories. In target records, the moved B link
has that `entity_operation_id`; its original `NO_MATCH` decision remains.
No separate `/audit` HTTP endpoint is introduced; operation audit is available
through entity history and SQL.

## 4. Replay the key without duplicate effects

```powershell
$replay = Invoke-ResolvePost "/v1/entities/$resolveTargetId/merge" $resolveMergeBody $resolveMergeKey
Assert-Resolve ($replay.Status -eq 200) 'Replay status mismatch'
Assert-Resolve ($replay.Headers['Idempotency-Replayed'] -contains 'true') 'Missing replay header'
Assert-Resolve (($replay.Body | ConvertTo-Json -Depth 20 -Compress) -eq ($merge.Body | ConvertTo-Json -Depth 20 -Compress)) 'Replay body changed'
Invoke-ResolveSql @"
SELECT (SELECT count(*) FROM public.entity_operations WHERE tenant_id = '$resolveTenantId') AS operations,
       (SELECT count(*) FROM public.entity_canonical_versions WHERE tenant_id = '$resolveTenantId') AS snapshots,
       (SELECT count(*) FROM public.entities WHERE tenant_id = '$resolveTenantId') AS entities;
"@
```

Expected: `1|4|2` (one operation, four snapshots including the two originals,
two entities). A replay uses its original successful response despite stale
expected versions; it does not execute another merge.

## 5. Update a moved source record, then reverse using latest data

```powershell
$resolveRecordB.data.name = 'Solomon Bekele Updated'
$updated = Invoke-ResolvePost '/v1/records' $resolveRecordB
Assert-Resolve ($updated.Status -eq 200 -and $updated.Body.version -eq 2) 'Source update failed'
Assert-Resolve ($updated.Body.entity_id -eq $resolveTargetId) 'Update lost current membership'
Assert-Resolve ($updated.Body.entity_operation_id -eq $resolveMergeEventId) 'Manual assignment metadata missing'
$updatedTarget = Get-ResolveEntity $resolveTargetId
Assert-Resolve ($updatedTarget.canonical_data.name -eq 'Solomon Bekele Updated') 'Latest source value missing'
$undoBody = @{
  merge_event_id = $resolveMergeEventId
  expected_version = $updatedTarget.canonical_version
  reason = 'Demo: reverse explicit merge using current data'
}
$undo = Invoke-ResolvePost "/v1/entities/$resolveTargetId/split" $undoBody "undo-$resolveRun"
Assert-Resolve ($undo.Status -eq 200 -and $undo.Body.operation -eq 'UNMERGE') 'Reversal failed'
Assert-Resolve ($undo.Body.target_entity_id -eq $resolveSourceId) 'Original source ID was not restored'
Assert-Resolve ($undo.Body.reversed_operation_id -eq $resolveMergeEventId) 'Missing reversal reference'
$restored = Get-ResolveEntity $resolveSourceId
$remaining = Get-ResolveEntity $resolveTargetId
Assert-Resolve ($restored.status -eq 'ACTIVE' -and $null -eq $restored.merged_into_entity_id) 'Restored lifecycle mismatch'
Assert-Resolve ($restored.canonical_data.name -eq 'Solomon Bekele Updated') 'Reversal restored stale data'
Assert-Resolve ($restored.record_count -eq 1 -and $remaining.record_count -eq 1) 'Reversal membership mismatch'
$restored | ConvertTo-Json -Depth 20
$remaining | ConvertTo-Json -Depth 20
Invoke-RestMethod "$resolveBaseUrl/v1/entities/$resolveSourceId/history?limit=100" `
  -Headers $resolveHeaders | ConvertTo-Json -Depth 30
# Replaying the original ingestion key is deliberately historical:
$oldIngestion = Invoke-ResolvePost '/v1/records' @{
  source = $resolveSourceB; external_id = "bravo-$resolveRun"; entity_type = 'person'
  data = @{ name = 'Solomon Bekele'; email = "solomon.$resolveRun@example.net" }
} "ingest-b-$resolveRun"
Assert-Resolve ($oldIngestion.Body.version -eq 1) 'Historical ingestion replay changed'
```

Expected: B is ACTIVE at its **original** entity ID with the updated name,
not its pre-merge value. A retains its own record. Both receive one SPLIT
snapshot associated with the new UNMERGE audit, while the original MERGE
event and snapshots remain. Stored ingestion replay returns original version
1 without overwriting version 2. A replay of the original merge key likewise
returns its historical MERGE result; fresh GETs remain the source of current state.

## 6. Add a matching record, then split a selected proper subset

```powershell
$resolveRecordC = @{
  source = $resolveSourceA; external_id = "charlie-$resolveRun"; entity_type = 'person'
  data = @{ name = 'Solomon Bekele Updated'; email = "solomon.$resolveRun@example.net" }
}
$c = Invoke-ResolvePost '/v1/records' $resolveRecordC
Assert-Resolve ($c.Status -eq 201 -and $c.Body.decision -eq 'AUTO_MATCH') 'Matching fixture did not link'
Assert-Resolve ($c.Body.entity_id -eq $resolveSourceId) 'Expected restored source membership'
$beforeSplit = Get-ResolveEntity $resolveSourceId
$selectedBody = @{
  record_ids = @($c.Body.record_id)
  expected_version = $beforeSplit.canonical_version
  reason = 'Demo: selected-record split'
}
$selectedKey = "selected-$resolveRun"
$split = Invoke-ResolvePost "/v1/entities/$resolveSourceId/split" $selectedBody $selectedKey
Assert-Resolve ($split.Status -eq 201 -and $split.Body.operation -eq 'SPLIT') 'Selected split failed'
$resolveNewEntityId = $split.Body.target_entity_id
Assert-Resolve ($resolveNewEntityId -ne $resolveSourceId) 'Selected split reused source ID'
$splitReplay = Invoke-ResolvePost "/v1/entities/$resolveSourceId/split" $selectedBody $selectedKey
Assert-Resolve ($splitReplay.Status -eq 201 -and $splitReplay.Body.operation_id -eq $split.Body.operation_id) 'Selected split replay failed'
foreach ($id in @($resolveSourceId, $resolveNewEntityId)) {
  Get-ResolveEntity $id | ConvertTo-Json -Depth 20
  Invoke-RestMethod "$resolveBaseUrl/v1/entities/$id/records" `
    -Headers $resolveHeaders | ConvertTo-Json -Depth 30
}
```

Expected: two ACTIVE one-record entities. The new ID has version 1 and C's
link still reports its original `AUTO_MATCH` evidence with the new manual
operation ID. The original source remains nonempty. Each receives exactly
one SPLIT snapshot; replay creates no additional entity or snapshot.

## 7. Exercise validation, conflicts, authorization, and tenant isolation

Every request below must fail without new operation or canonical history.
The source ID now has one record; build requests with current versions:

```powershell
$currentA = Get-ResolveEntity $resolveTargetId
$currentB = Get-ResolveEntity $resolveSourceId
$validMerge = @{
  source_entity_id = $resolveSourceId
  expected_source_version = $currentB.canonical_version
  expected_target_version = $currentA.canonical_version
  reason = 'Demo denial request'
}
$missingKey = Invoke-ResolvePost "/v1/entities/$resolveTargetId/merge" $validMerge
$missingKey | ConvertTo-Json -Depth 10 # 400 IDEMPOTENCY_KEY_REQUIRED
$changedReplay = Invoke-ResolvePost "/v1/entities/$resolveTargetId/merge" $validMerge $resolveMergeKey
$changedReplay | ConvertTo-Json -Depth 10 # 409 IDEMPOTENCY_KEY_REUSED
$staleBody = @{} + $validMerge
$staleBody.expected_target_version = 0
$stale = Invoke-ResolvePost "/v1/entities/$resolveTargetId/merge" $staleBody "stale-$resolveRun"
$stale | ConvertTo-Json -Depth 10 # 409 ENTITY_VERSION_CONFLICT
$full = Invoke-ResolvePost "/v1/entities/$resolveSourceId/split" @{
  record_ids = @($resolveMovedRecordId); expected_version = $currentB.canonical_version
  reason = 'Cannot empty the source'
} "full-$resolveRun"
$full | ConvertTo-Json -Depth 10 # 409 INVALID_ENTITY_SPLIT
$both = Invoke-ResolvePost "/v1/entities/$resolveSourceId/split" @{
  record_ids = @($resolveMovedRecordId); merge_event_id = $resolveMergeEventId
  expected_version = $currentB.canonical_version; reason = 'Invalid selector'
} "both-$resolveRun"
$both | ConvertTo-Json -Depth 10 # 400 BAD_REQUEST
$duplicateUndo = Invoke-ResolvePost "/v1/entities/$resolveTargetId/split" @{
  merge_event_id = $resolveMergeEventId; expected_version = $currentA.canonical_version
  reason = 'Already reversed'
} "double-undo-$resolveRun"
$duplicateUndo | ConvertTo-Json -Depth 10 # 409 MERGE_ALREADY_REVERSED
$noAuth = Invoke-ResolvePost "/v1/entities/$resolveTargetId/merge" $validMerge "noauth-$resolveRun" @{}
$noAuth | ConvertTo-Json -Depth 10 # 401
$badAuth = Invoke-ResolvePost "/v1/entities/$resolveTargetId/merge" $validMerge "badauth-$resolveRun" @{
  Authorization = 'Bearer rslv_test_invalid'
}
$badAuth | ConvertTo-Json -Depth 10 # 401
npm.cmd run auth:bootstrap -- --tenant-name "Day5 foreign read $resolveRun" `
  --environment test --scopes entities:read
$resolveForeignKey = 'rslv_test_REPLACE_WITH_FOREIGN_READ_KEY'
$foreignHeaders = @{ Authorization = "Bearer $resolveForeignKey" }
$missingScope = Invoke-ResolvePost "/v1/entities/$resolveTargetId/merge" $validMerge "scope-$resolveRun" $foreignHeaders
$missingScope | ConvertTo-Json -Depth 10 # 403 before resource access
$foreignRead = Invoke-WebRequest "$resolveBaseUrl/v1/entities/$resolveTargetId" `
  -Headers $foreignHeaders -SkipHttpErrorCheck
$foreignRead.StatusCode # 404, same ENTITY_NOT_FOUND as a nonexistent UUID
$foreignRead.Content
```

Also inspect Swagger for both modes, required scopes/key, 200 merge/reversal,
201 selected split, and error schemas. To exercise a foreign ID on the
mutation service (rather than the scope guard), create another fresh bootstrap
tenant with `entities:merge,entities:split`; use that key on the first tenant's
IDs. Expect 404. An unknown/foreign `merge_event_id` also returns
`MERGE_EVENT_NOT_FOUND`; an unknown/foreign/other-entity selected record
returns `SOURCE_RECORD_NOT_FOUND`. Revoked keys return 401. Automated tests
cover these, malformed/duplicate selectors, same-entity/type conflicts,
1001-member limits, concurrency, chains, and rollback without constructing
large manual datasets.

## 8. Inspect SQL audit, raw versions, and immutable history

```powershell
Invoke-ResolveSql @"
SELECT id, status, merged_into_entity_id, canonical_version, canonical_data
FROM public.entities WHERE tenant_id = '$resolveTenantId' ORDER BY id;
SELECT id, type, operation_version, source_entity_id, target_entity_id,
       record_ids, reason, actor_api_key_id, reversed_operation_id,
       source_version_before, source_version_after, target_version_before, target_version_after
FROM public.entity_operations WHERE tenant_id = '$resolveTenantId' ORDER BY created_at, id;
SELECT source_record_id, version, raw_payload
FROM public.source_record_versions WHERE tenant_id = '$resolveTenantId'
ORDER BY source_record_id, version;
SELECT id, entity_id, source_record_id, decision, score AS confidence, algorithm_version,
       last_entity_operation_id, created_at, explanation
FROM public.entity_record_links WHERE tenant_id = '$resolveTenantId' ORDER BY id;
SELECT entity_id, version, trigger_operation, entity_operation_id, canonicalization_version
FROM public.entity_canonical_versions WHERE tenant_id = '$resolveTenantId'
ORDER BY entity_id, version;
SELECT key, operation, response_status
FROM public.idempotency_requests WHERE tenant_id = '$resolveTenantId' ORDER BY key;
"@
$snapshotsAfter = Invoke-ResolveSql @"
SELECT jsonb_agg(to_jsonb(v) ORDER BY v.entity_id, v.version)
FROM public.entity_canonical_versions v
WHERE v.tenant_id = '$resolveTenantId'
AND v.entity_id IN ('$resolveTargetId', '$resolveSourceId') AND v.version = 1;
"@
Assert-Resolve ($snapshotsAfter -eq $resolveOldSnapshots) 'Original canonical snapshots changed'
```

Expected after the successful sequence: three ACTIVE entities and three
operation rows (MERGE, UNMERGE referencing MERGE, SPLIT); each operation has
two linked snapshots. A has one raw version, B has **two** (both names remain),
C has one. Original A/B link IDs and original evidence remain; C's original
AUTO_MATCH feature row survives selected split. No denial key appears in the
ledger. The earlier raw-evidence equality check applies before the intentional
B update; do not compare the entire raw table to that earlier value afterward.
Do not delete audit/history rows to clean up a demonstration.

## 9. Run the automated regression matrix

Stop the demo API when finished (Ctrl+C in its terminal). From the checkout:

```powershell
$env:DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
npm.cmd run prisma:validate
npm.cmd test
npm.cmd run test:integration
```

Expected: every command exits 0. Run sequentially to limit memory pressure.
Integration tests create/migrate/drop their own isolated PostgreSQL schemas;
they do not reset the public demo schema. PostgreSQL and Redis must be ready.
Typecheck/build both compile shared packages; this overlap is intentional
when explicitly reproducing the full verification matrix.
