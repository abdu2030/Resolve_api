# Test rate limits, health, metrics, and audit events

Run the checks from the repository root.

```powershell
docker compose up -d --wait postgres redis
$env:TEST_DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm.cmd ci
npm.cmd run build
npm.cmd test
npm.cmd run test:integration -- --runTestsByPath tests/integration/week3-day4-rate-limits.integration.ts tests/integration/week3-day4-audit.integration.ts
```

The integration tests use separate PostgreSQL schemas and Redis namespaces.
The rate-limit suite checks concurrent requests, distinct keys in one tenant,
cross-tenant isolation, batch quotas, and the Redis error response. The audit
suite checks that an event records the authenticated actor and is committed
with the operation it describes.

## Check a running API

Set `METRICS_TOKEN` to a randomly generated 32-byte secret encoded as 64 hex
characters before starting the API. For Docker Compose, set it in the untracked
`.env`. Use the same value in the scraper's secret store.

```powershell
$env:METRICS_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$resolveBaseUrl = 'http://localhost:3000'
Invoke-RestMethod "$resolveBaseUrl/health/live"
Invoke-RestMethod "$resolveBaseUrl/health/ready"
Invoke-WebRequest -Uri "$resolveBaseUrl/metrics" -Headers @{
  Authorization = "Bearer $env:METRICS_TOKEN"
} | Select-Object -ExpandProperty Content
```

Liveness reports whether the API can respond. Readiness probes PostgreSQL and
Redis and returns `503` when either dependency is down or does not answer in
time. `/health` returns the same readiness response as before. The metrics
endpoint returns `404` when the token is unset and `401` when a configured
token is missing or invalid. The scrape exposes `resolve_http_requests_total`,
`resolve_http_errors_total`, `resolve_http_rate_limited_total`, and a histogram
named `resolve_http_request_duration_seconds`. For p95 latency across scraped
replicas, use the following PromQL expression. Use `0.50` or `0.99` for p50 or p99.

```promql
histogram_quantile(0.95, sum by (le) (rate(resolve_http_request_duration_seconds_bucket[5m])))
```

To see `429` in a local API, restart it with `RATE_LIMIT_KEY_MAX=2` and use a
fresh API key with `jobs:read`. The example uses PowerShell 7 and requests a job
ID that has no corresponding job.

```powershell
$headers = @{ Authorization = "Bearer $env:RESOLVE_TEST_API_KEY" }
$jobId = [guid]::NewGuid().ToString()
1..3 | ForEach-Object {
  $response = Invoke-WebRequest "$resolveBaseUrl/v1/jobs/$jobId" -Headers $headers -SkipHttpErrorCheck
  [pscustomobject]@{ Status = $response.StatusCode; RetryAfter = $response.Headers['Retry-After'] }
}
```

The first two responses should be `404` and the third `429`, with
`Retry-After` in seconds. Review logs using the response's `X-Request-Id`.
The completion log uses the route template and bounded HTTP metadata.

An authorized database operator can inspect recent audit events for a tenant
by filtering `audit_events` on `tenant_id` and ordering by `created_at`
and `id` descending. Use the resource ID and action to correlate the event
with a matching domain record. The following actions are recorded.

| Action                                                   | Resource identified by the event                    |
| -------------------------------------------------------- | --------------------------------------------------- |
| `api_key.bootstrapped`                                   | Newly created API key                               |
| `source.registered`                                      | New source system                                   |
| `review.resolved`                                        | Review case with a reference to the review decision |
| `entity.merged`, `entity.split`, `entity.merge_reversed` | Entity with a reference to its operation history    |
| `webhook_endpoint.registered`                            | New webhook endpoint                                |
| `webhook_delivery.replayed`                              | Webhook delivery with its endpoint and event IDs    |

Bootstrap events have no API-key actor. All other events reference an
authenticated API key belonging to the event's tenant.
