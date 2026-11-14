# Test batch resolution in PowerShell

## 1. Prepare the database and build

Use PowerShell 7. Run the commands from your main checkout.

```powershell
$checkout = 'C:\Users\Admin\Desktop\Resolve Api'
Set-Location -LiteralPath $checkout
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
$env:DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
docker compose up -d --wait --no-build --pull never postgres redis
npm.cmd run prisma:migrate:deploy
npm.cmd run build
```

Open Docker Desktop first. Stop if a command fails. These commands use the
installed dependencies and existing Compose images. Run `npm ci` only on a
checkout without installed dependencies. Adjust `.env` and `DATABASE_URL` to
match your local database and Redis if you use different settings.

## 2. Start the API and leave the worker stopped

Open another terminal in the same checkout:

```powershell
node --env-file=.env apps/api/dist/main.js
```

Use a free API port. If a worker already processes this database, stop it for
the queued-state check. Return to the first terminal and create a test tenant:

```powershell
$base = 'http://localhost:3000'
Invoke-RestMethod "$base/health"
$run = [guid]::NewGuid().ToString('N').Substring(0, 10)
npm.cmd run auth:bootstrap -- --tenant-name "Batch demo $run" --environment test `
  --scopes sources:write,records:write,jobs:read
$key = 'REPLACE_WITH_GENERATED_TEST_KEY'
$headers = @{ Authorization = "Bearer $key" }
foreach ($source in @('crm', 'billing')) {
  Invoke-RestMethod -Method Post -Uri "$base/v1/sources" -Headers $headers `
    -ContentType 'application/json' -Body (@{ name = $source; type = 'api' } | ConvertTo-Json)
}
```

Replace `$key` with the secret shown by bootstrap. Each bootstrap call creates a
new tenant. Existing API keys need `records:write` to submit and `jobs:read` to poll.

## 3. Submit and replay a batch

```powershell
$batch = @{ records = @(
  @{ source = 'crm'; external_id = 'person-1'; entity_type = 'person'
     data = @{ name = '  Synthetic Person  '; email = "demo-$run@example.com"; phone = '+251911987654' } },
  @{ source = 'billing'; external_id = 'person-2'; entity_type = 'person'
     data = @{ name = 'Synthetic Person'; email = "demo-$run@EXAMPLE.COM"; phone = '+251911987654' } }
) }
$submit = $headers + @{ 'Idempotency-Key' = "batch-$run" }
$json = $batch | ConvertTo-Json -Depth 8
$response = Invoke-WebRequest -Method Post -Uri "$base/v1/records/batch" -Headers $submit `
  -ContentType 'application/json' -Body $json
$job = $response.Content | ConvertFrom-Json
$jobUrl = "$base/v1/jobs/$($job.job_id)"
$response.StatusCode
$response.Headers.Location
$job
Invoke-RestMethod -Uri $jobUrl -Headers $headers
$replay = Invoke-WebRequest -Method Post -Uri "$base/v1/records/batch" -Headers $submit `
  -ContentType 'application/json' -Body $json
$replay.Headers['Idempotency-Replayed']
$replay.Content | ConvertFrom-Json
```

Expect `202`, a `Location` header pointing to the job, and a `QUEUED` job with
two total records and zero processed. The replay has the same job ID and a
`true` replay header. A different body under the same key returns `409`.

## 4. Start the worker and poll for results

Open a third terminal in the same checkout:

```powershell
node --env-file=.env apps/worker/dist/main.js
```

In the first terminal, poll for completion:

```powershell
for ($i = 0; $i -lt 30; $i++) {
  $state = Invoke-RestMethod -Uri $jobUrl -Headers $headers
  $state | Select-Object status, processed_records, succeeded_records, failed_records, attempts
  if ($state.status -in @('SUCCEEDED', 'FAILED')) { break }
  Start-Sleep -Seconds 1
}
if ($state.status -ne 'SUCCEEDED') { throw "Expected success, got $($state.status)" }
$state.results | ForEach-Object { $_.result | Select-Object external_id, decision, entity_id }
```

Expect two successes in one attempt. The CRM record returns `NO_MATCH` and creates
an entity. The billing record returns `AUTO_MATCH` with the same entity ID.
Swagger lists both endpoints at `http://localhost:3000/docs`.

## 5. Run the automated checks

```powershell
npm.cmd run test:integration -- --runTestsByPath tests/integration/week3-day1-batch.integration.ts
```

This uses a temporary PostgreSQL schema and a unique Redis queue namespace. It
checks job replay, scope and tenant denials, ordered resolution, raw payload
preservation, retries after partial success, retry exhaustion, and continuation
after a permanent record conflict. Set `TEST_DATABASE_URL`, `TEST_REDIS_HOST`,
or `TEST_REDIS_PORT` to point to a different local test stack.
