# Week 3 Day 5 security and performance validation

## Reproduce the checks

Run from the repository root with a local PostgreSQL and Redis test stack.
The suites apply migrations to temporary schemas, use synthetic fixtures, and
clean up their own schemas and queue keys.

```powershell
docker compose up -d --wait postgres redis
$env:TEST_DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm.cmd ci
npm.cmd run build
npm.cmd test
npm.cmd run test:integration
```

Run the larger query-plan check and the load benchmark with no other test runs
using the same stack. Both emit aggregate JSON in the test output.

```powershell
$env:RUN_RESOLVE_LOAD = '1'
try {
  npm.cmd run test:integration -- --runTestsByPath tests/integration/day6-blocking.integration.ts tests/integration/week3-day5-load.integration.ts
} finally {
  Remove-Item Env:RUN_RESOLVE_LOAD
}
```

The default integration suite checks all four query plans with 2,000
background records. The opt-in run repeats the plans with 20,000 records and
includes the synthetic HTTP workload. There are no timing assertions in CI.
The assertions cover the expected selective indexes, bounded query results,
the candidate cap, and correct resolution of every duplicate in the load.

## Security coverage

The existing test suites exercise the API and persistence boundary with real
PostgreSQL and Redis. The HTTP authorization fixture verifies authentication
behavior with predictable key and tenant state.

| Boundary                  | Verified behavior                                                                                                                                          | Tests                                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and scopes | Missing, invalid, revoked, and inactive-tenant credentials are rejected. Keys without the requested scope receive `403`.                                   | `auth.integration.spec.ts`, `day4-api.integration.ts`, `week2-day6-reviews.integration.ts`                                                                                                                                                                                |
| Tenant isolation          | Foreign sources, entities, jobs, review cases, and webhook deliveries are hidden. Candidate generation excludes other tenants.                             | `day3-resolver-api.integration.ts`, `day6-blocking.integration.ts`, `week2-day4-entities-api.integration.ts`, `week2-day5-entity-operations.integration.ts`, `week2-day6-reviews.integration.ts`, `week3-day1-batch.integration.ts`, `week3-day3-webhooks.integration.ts` |
| Rate limits and input     | Concurrent requests respect per-key and tenant budgets and batch quotas. Redis failure returns `503`. Malformed and oversized JSON return `400` and `413`. | `week3-day4-rate-limits.integration.ts`, `http-boundary.spec.ts`                                                                                                                                                                                                          |
| Outbound webhooks         | Unsafe URL schemes and non-public DNS answers are rejected. Scope checks protect registration, and signing secrets are encrypted in storage.               | `webhook-transport.spec.ts`, `week3-day3-webhooks.integration.ts`                                                                                                                                                                                                         |
| Audit and telemetry       | Foreign audit actors are rejected. Audit entries are append-only. Request logs omit raw request values, and scraping requires a separate operator token.   | `week3-day4-audit.integration.ts`, `http-observability.e2e-spec.ts`                                                                                                                                                                                                       |

## Local performance baseline

Measured on November 22, 2026, from GitHub main `2632b35` with the Day 5
test changes. The Windows host used an Intel Core i7-1355U and about 16 GiB
of RAM. Docker reported 12 logical CPUs and about 7.6 GiB, with
PostgreSQL 18.7 and Redis 8.10.3. The Node.js 24.22.3 process hosted the
API, worker, and HTTP test client. These figures describe a local run.

The direct phase used 80 measured requests across 40 identities with up
to four concurrent requests. CRM and billing shared synthetic identifiers
within each pair. Two warm-up requests were excluded. The batch phase
submitted six concurrent 100-record jobs and observed completion by
polling each job every 250 ms. Every duplicate linked to its expected
entity, and every batch finished in one attempt.

| Measure                         |              Result |
| ------------------------------- | ------------------: |
| Direct HTTP p50                 |           222.33 ms |
| Direct HTTP p95                 |           323.61 ms |
| Direct HTTP p99                 |           412.20 ms |
| Batch acceptance range          | 417.57 to 625.40 ms |
| Observed batch completion range |    13.71 to 63.88 s |
| 600-record batch wall time      |             63.90 s |
| End-to-end batch throughput     |      9.39 records/s |

PostgreSQL activity was sampled every 25 ms on the load connections only.
Five samples contained an active statement above 25 ms. The longest
observed elapsed time was 27.83 ms. The observations were three
`COMMIT`, one `INSERT`, and one `UPDATE`. This sampling can miss
statements between observations or see a statement more than once.

### Candidate generation

PostgreSQL planned the same parameterized blocking queries used by the
API. The check ran `ANALYZE` on the fixture tables, then captured
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with normal planner settings.
Each selective lookup used its expected index and returned one supporting
row at both sizes. None used a sequential scan on `source_records`.

| Selective signal         | 2,000 records | 20,000 records |
| ------------------------ | ------------: | -------------: |
| Exact email              |      0.325 ms |       0.418 ms |
| Exact phone              |      0.331 ms |       0.405 ms |
| Company domain           |      0.219 ms |       0.324 ms |
| Name prefix and location |      0.339 ms |       0.336 ms |

All selective plans had 9–10 shared-buffer hits and zero shared-buffer
reads in this run. These measurements are individual plan executions.

The common-email fixture held 160 matches at each size. With the test
cap of two, the service returned two candidates and set `truncated: true`.
At the default cap, the SQL probe returned 101 rows so the service can
detect truncation at 100 candidates.

| Common-email measurement                   | 2,000 records | 20,000 records |
| ------------------------------------------ | ------------: | -------------: |
| SQL limit 3 execution time                 |      1.779 ms |      19.882 ms |
| SQL limit 3 shared buffer hits             |         1,644 |         15,234 |
| SQL limit 3 source-record index scan loops |           388 |          3,780 |
| SQL limit 101 execution time               |      2.345 ms |       9.825 ms |
| SQL limit 101 shared buffer hits           |           549 |          1,079 |

The smaller-limit plan walked entity links in order and probed source
records by primary key. Even with a fixed number of matching entities and
a fixed output cap, it did more work as unrelated rows increased. The
default-limit probe used the email index at both sizes. This is the
performance follow-up from the run. The existing index and candidate
selection behavior are retained.
