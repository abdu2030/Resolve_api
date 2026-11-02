# Week 2 Day 6: test the review API

Run these steps in order using PowerShell 7, Node24+, and Docker Desktop.
Use a checkout containing the Day 6 implementation. The commands below use
`C:\Users\Admin\Desktop\Resolve Api`; adjust this path if your checkout is elsewhere.
Use the same checkout in both terminals. The prepared machine reuses installed
packages; no worker is needed.

## 1. Start dependencies, migrate, build

```powershell
Set-Location -LiteralPath 'C:\Users\Admin\Desktop\Resolve Api'
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
$env:DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
docker compose up -d --wait postgres redis
npm.cmd run prisma:validate
npm.cmd run prisma:migrate:deploy
npm.cmd run prisma:migrate:deploy
npm.cmd run build
```

Stop on a nonzero exit. The second migration deploy reports no pending changes.
Adjust the local URL only if you changed Compose credentials. Do not reset
the database. In a second terminal, with port3000 free of older API processes:

```powershell
Set-Location -LiteralPath 'C:\Users\Admin\Desktop\Resolve Api'
$env:DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
$env:API_PORT = '3000'
node --env-file=.env apps/api/dist/main.js
```

Leave the API running; continue in the first terminal.

## 2. Create fresh credentials and a source

```powershell
$base = 'http://localhost:3000'
Invoke-RestMethod "$base/health"
$run = [guid]::NewGuid().ToString('N').Substring(0, 8)
npm.cmd run auth:bootstrap -- --tenant-name "Day6 reviews $run" `
  --environment test `
  --scopes sources:write,records:write,entities:read,reviews:read,reviews:write
$tenant = 'REPLACE_WITH_TENANT_UUID'
$apiKey = 'rslv_test_REPLACE_WITH_SHOWN_SECRET'
$headers = @{ Authorization = "Bearer $apiKey" }
function Post-Resolve([string]$Path, [object]$Value, [string]$Key) {
  $auth = @{} + $headers
  if ($Key) { $auth['Idempotency-Key'] = $Key }
  $r = Invoke-WebRequest -Method Post -Uri "$base$Path" -Headers $auth `
    -ContentType 'application/json' -Body ($Value | ConvertTo-Json -Depth 30) -SkipHttpErrorCheck
  [pscustomobject]@{ Status = [int]$r.StatusCode; Headers = $r.Headers; Body = ($r.Content | ConvertFrom-Json) }
}
function Check([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
function Read-Case([string]$Id) { Invoke-RestMethod "$base/v1/reviews/$Id" -Headers $headers }
$source = "reviews_$run"
$registered = Post-Resolve '/v1/sources' @{ name = $source; type = 'api' }
Check ($registered.Status -eq 201) 'Source registration failed'
```

Expected: health200, source201. Replace the placeholders using bootstrap output.
Existing keys do not gain review scopes automatically. Keep secrets in your
terminal. Swagger: `/docs`; OpenAPI JSON: `/docs-json`.

## 3. Create uncertain pairs, list cases, inspect evidence

```powershell
function New-ReviewPair([string]$Label, [string]$PhoneA, [string]$PhoneB) {
  $common = @{ name = "Review $Label $run"; address = @{ city = "City $Label $run"; country = 'ET' } }
  $a = Post-Resolve '/v1/records' @{
    source = $source; external_id = "$Label-base"; entity_type = 'person'
    data = (@{} + $common + @{ phone = $PhoneA })
  }
  $payload = @{
    source = $source; external_id = "$Label-incoming"; entity_type = 'person'
    data = (@{} + $common + @{ phone = $PhoneB })
  }
  $oldKey = [guid]::NewGuid().ToString()
  $b = Post-Resolve '/v1/records' $payload $oldKey
  Check ($a.Status -eq 201 -and $b.Status -eq 201) 'Ingestion failed'
  Check ($b.Body.decision -eq 'REVIEW') 'Expected REVIEW'
  [pscustomobject]@{ Candidate = $a.Body; Incoming = $b.Body; Payload = $payload; OldKey = $oldKey }
}
$approvePair = New-ReviewPair 'Approve' '+251911000011' '+251922000011'
$rejectPair = New-ReviewPair 'Reject' '+251911000021' '+251922000021'
$cases = Invoke-RestMethod "$base/v1/reviews?limit=25" -Headers $headers
Check ($cases.items.Count -eq 2) 'Expected two OPEN cases'
$approveId = ($cases.items | Where-Object source_record_id -eq $approvePair.Incoming.record_id).review_id
$rejectId = ($cases.items | Where-Object source_record_id -eq $rejectPair.Incoming.record_id).review_id
$detail = Read-Case $approveId
$detail | ConvertTo-Json -Depth 30
Check ($detail.approval_available -eq $true) 'Approval should be available'
```

The same name/location with different phones produces REVIEW. Inspect original
`evidence.score_inputs`, `scoring_explanation`, score/algorithm. Source/candidate
objects distinguish current data from captured evidence versions/raw payloads.
The candidate entity exposes its current status and canonical version. Unknown
legacy evidence versions/raw snapshots are null. OPEN sources remain unlinked.

## 4. Approve, read canonical history, replay

```powershell
$approveBody = @{
  decision = 'APPROVE'; reason = 'Confirmed the same person after inspection'
  expected_source_version = $detail.source_record.current_version
  expected_candidate_version = $detail.candidate_entity.canonical_version
}
$decisionKey = [guid]::NewGuid().ToString()
$approved = Post-Resolve "/v1/reviews/$approveId/decision" $approveBody $decisionKey
Check ($approved.Status -eq 200) 'Approval failed'
Check ($approved.Body.entity_id -eq $approvePair.Candidate.entity_id) 'Wrong target'
$entityId = $approved.Body.entity_id
$entity = Invoke-RestMethod "$base/v1/entities/$entityId" -Headers $headers
$history = Invoke-RestMethod "$base/v1/entities/$entityId/history" -Headers $headers
Check ($entity.record_count -eq 2) 'Expected two linked records'
Check ($history.items[0].trigger.operation -eq 'REVIEW_APPROVED') 'Missing review history'
Check ($history.items[0].review_decision.review_decision_id -eq $approved.Body.review_decision_id) 'Missing audit reference'
$replay = Post-Resolve "/v1/reviews/$approveId/decision" $approveBody $decisionKey
Check ($replay.Status -eq 200) 'Replay failed'
Check ($replay.Headers['Idempotency-Replayed'] -contains 'true') 'Missing replay header'
Check ($replay.Body.review_decision_id -eq $approved.Body.review_decision_id) 'Duplicate outcome'
$fresh = Post-Resolve '/v1/records' $approvePair.Payload
Check ($fresh.Body.decision -eq 'AUTO_MATCH') 'Expected current linked semantics'
Check ($fresh.Body.review_decision_id -eq $approved.Body.review_decision_id) 'Missing human marker'
$old = Post-Resolve '/v1/records' $approvePair.Payload $approvePair.OldKey
Check ($old.Body.decision -eq 'REVIEW') 'Original keyed response must remain historical'
```

The stored link preserves the machine REVIEW score/explanation. The human audit
explains its assignment. Fresh ingestion uses linked AUTO_MATCH/NO_MATCH semantics
and includes `review_decision_id`; it does not invent a new confidence score.
Replay must not add another outcome, entity, link, or canonical snapshot.

## 5. Reject and inspect the separate entity

```powershell
$other = Read-Case $rejectId
$rejectBody = @{
  decision = 'REJECT'; reason = 'These are different people'
  expected_source_version = $other.source_record.current_version
  expected_candidate_version = $other.candidate_entity.canonical_version
}
$rejected = Post-Resolve "/v1/reviews/$rejectId/decision" $rejectBody ([guid]::NewGuid().ToString())
Check ($rejected.Status -eq 200) 'Rejection failed'
Check ($rejected.Body.entity_id -ne $rejectPair.Candidate.entity_id) 'Expected a separate entity'
$separate = Invoke-RestMethod "$base/v1/entities/$($rejected.Body.entity_id)" -Headers $headers
Check ($separate.record_count -eq 1) 'Expected one separate record'
$resolved = Invoke-RestMethod "$base/v1/reviews?status=RESOLVED" -Headers $headers
Check ($resolved.items.Count -eq 2) 'Expected two RESOLVED cases'
Check ((Invoke-RestMethod "$base/v1/reviews" -Headers $headers).items.Count -eq 0) 'OPEN queue should be empty'
```

Rejection uses current source values, preserves the candidate and original
evidence, and appends `REVIEW_REJECTED` history to the new entity.

## 6. Test denials and stale evidence

```powershell
$again = Post-Resolve "/v1/reviews/$approveId/decision" $approveBody ([guid]::NewGuid().ToString())
Check ($again.Status -eq 409 -and $again.Body.error.code -eq 'REVIEW_ALREADY_RESOLVED') 'Expected resolved conflict'
$missing = Post-Resolve "/v1/reviews/$approveId/decision" $approveBody
Check ($missing.Status -eq 400 -and $missing.Body.error.code -eq 'IDEMPOTENCY_KEY_REQUIRED') 'Expected required key'
$changed = @{} + $approveBody; $changed.reason = 'Different request'
$conflict = Post-Resolve "/v1/reviews/$approveId/decision" $changed $decisionKey
Check ($conflict.Status -eq 409 -and $conflict.Body.error.code -eq 'IDEMPOTENCY_KEY_REUSED') 'Expected key conflict'
$stalePair = New-ReviewPair 'Stale' '+251911000031' '+251922000031'
$open = Invoke-RestMethod "$base/v1/reviews" -Headers $headers
$staleId = ($open.items | Where-Object source_record_id -eq $stalePair.Incoming.record_id).review_id
$before = Read-Case $staleId
$stalePair.Payload.data.name = "Changed $run"
$update = Post-Resolve '/v1/records' $stalePair.Payload
Check ($update.Status -eq 200) 'Update failed'
$staleBody = @{
  decision = 'APPROVE'; reason = 'Attempt with stale version'
  expected_source_version = $before.source_record.current_version
  expected_candidate_version = $before.candidate_entity.canonical_version
}
$denied = Post-Resolve "/v1/reviews/$staleId/decision" $staleBody ([guid]::NewGuid().ToString())
Check ($denied.Status -eq 409 -and $denied.Body.error.code -eq 'REVIEW_SOURCE_VERSION_CONFLICT') 'Expected stale source denial'
Check ((Read-Case $staleId).approval_available -eq $false) 'Changed evidence must block approval'
```

Even a fresh expected version cannot bypass changed scoring evidence. Safe
rejection remains possible using current source values. A moved supporting
record or merged candidate also blocks approval. Automated tests additionally
prove foreign-tenant404, revoked-key401, and missing-scope403 behavior.

## 7. Inspect storage and run automated checks

```powershell
@"
SELECT decision, reason, actor_api_key_id, entity_id, source_record_version,
       candidate_record_version, candidate_canonical_version, canonical_version,
       policy_version, created_at
FROM review_decisions WHERE tenant_id = '$tenant' ORDER BY created_at;
SELECT status, count(*) FROM review_cases WHERE tenant_id = '$tenant' GROUP BY status;
SELECT source_record_id, decision, score, review_decision_id
FROM entity_record_links WHERE tenant_id = '$tenant' ORDER BY created_at;
"@ | docker compose exec -T postgres psql -U resolve -d resolve -v ON_ERROR_STOP=1
```

Expected: two immutable outcomes, two RESOLVED cases, and one OPEN stale case.
Audits contain actor/reason, observed versions, resulting entity/version, and
policy `review-v1`. Raw versions and original feature evidence remain intact.
Do not delete audit/history rows to clean up a demonstration.

Stop the demo API with Ctrl+C; from the checkout run sequentially:

```powershell
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run test:integration
```

All commands must exit0. Integration tests create/drop isolated schemas without
resetting your public data. Existing Node VM experimental warnings are informational.
