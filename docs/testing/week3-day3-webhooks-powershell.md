# Test webhook registration, retry, and replay

Run these commands from the repository root in PowerShell with Docker Desktop running.

```powershell
docker compose up -d --wait postgres redis
$env:TEST_DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm.cmd ci
npm.cmd run prisma:generate
npm.cmd test -- --runTestsByPath apps/api/src/webhooks/webhook-transport.spec.ts
npm.cmd run test:integration -- --runTestsByPath tests/integration/week3-day3-webhooks.integration.ts
```

The integration suite applies all migrations in an isolated PostgreSQL schema
and exercises real HTTP, PostgreSQL, Redis, and BullMQ. It substitutes the
callback transport so the tests can run without a live public receiver. The
suite covers scope and tenant denial, encrypted storage, keyed retries,
interrupted attempts, dead-letter status, and replay with the original event ID.

## Try a public receiver

Generate the encryption key once and set the same value for the API and worker.
Keep it available across restarts. A change to this key prevents the worker from
decrypting previously registered signing secrets.

```powershell
$env:WEBHOOK_ENCRYPTION_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

For Compose, set the value in the untracked `.env`. For separate API and worker
processes, export it in both terminal environments. Apply database migrations
before starting either process.

With a tenant API key that has `webhooks:manage` and an HTTPS receiver under
your control, generate a distinct signing secret and register the receiver.

```powershell
$headers = @{ Authorization = "Bearer $env:RESOLVE_TEST_API_KEY" }
$secret = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$endpoint = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/v1/webhook-endpoints' `
  -Headers $headers -ContentType 'application/json' -Body (@{
    url = $env:RESOLVE_TEST_WEBHOOK_URL
    events = @('record.resolved', 'job.completed')
    signing_secret = $secret
  } | ConvertTo-Json)
```

Provision the signing secret on your receiver and ingest a new test record as
that tenant. Inspect the resulting delivery and its attempts.

```powershell
$deliveryPath = "http://localhost:3000/v1/webhook-endpoints/$($endpoint.endpoint_id)/deliveries"
$deliveries = Invoke-RestMethod -Uri $deliveryPath -Headers $headers
$eventId = $deliveries.deliveries[0].event_id
Invoke-RestMethod -Uri "$deliveryPath/$eventId" -Headers $headers
```

Return a temporary `503` from the receiver to observe retry, or `400` to
observe dead-letter handling. Replay a finished delivery after restoring the
receiver. Reuse that idempotency key when retrying the replay request.

```powershell
$replayHeaders = $headers + @{ 'Idempotency-Key' = [guid]::NewGuid().ToString() }
Invoke-RestMethod -Method Post -Uri "$deliveryPath/$eventId/replay" -Headers $replayHeaders
```
