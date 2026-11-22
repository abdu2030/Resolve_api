# Week 3 Day 7 MVP demo

The [demo runner](../../examples/resolve-mvp-demo.mjs) submits synthetic Person
and Company records from the [CRM](../../examples/fixtures/demo-crm.json) and
[billing](../../examples/fixtures/demo-billing.json) fixtures through the
authenticated v1 API. It uses a new run ID for each execution and leaves the
synthetic records and audit history available for inspection.

## Run the demo

Start the API, worker, PostgreSQL, and Redis using the
[Compose quickstart](../getting-started.md#start-with-docker-compose).
With Node.js 24 or later, the demo runner needs no npm dependencies. Use two
dedicated test tenants because the demo writes records and intentionally merges
two distinct synthetic contacts before reversing the merge.

From the repository root, create one key for each tenant. Each command prints
its key once.

```powershell
docker compose exec -T api node apps/api/dist/auth/bootstrap-api-key.js --tenant-name "MVP demo primary" --environment test --scopes sources:write,records:write,entities:read,entities:merge,entities:split,reviews:read,reviews:write,jobs:read
docker compose exec -T api node apps/api/dist/auth/bootstrap-api-key.js --tenant-name "MVP demo isolation" --environment test --scopes sources:write,records:write,entities:read,reviews:read,jobs:read
```

In PowerShell, enter the two keys at the prompts. The default API URL is
`http://127.0.0.1:3000`. Set `RESOLVE_BASE_URL` if you mapped a different port.

```powershell
$env:RESOLVE_API_KEY = Read-Host -MaskInput 'Primary demo tenant key'
$env:RESOLVE_FOREIGN_API_KEY = Read-Host -MaskInput 'Isolation demo tenant key'
node examples/resolve-mvp-demo.mjs
```

The runner exits with code 1 if an API response or an assertion fails. A
successful run prints JSON with the run, entity, review, reversal, and job IDs.
Use the same keys again to run a fresh set of records. Clear
`RESOLVE_API_KEY` and `RESOLVE_FOREIGN_API_KEY` from your shell when finished.

## Expected results

| Scenario                       | What the runner verifies                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM seed and idempotent replay | The first Person gets `NO_MATCH` and creates a canonical entity. Repeating the same request and key returns the original response with `Idempotency-Replayed: true`. The entity still has one record.                                                                                        |
| New billing match              | The billing Person gets `AUTO_MATCH` with confidence `1` and links to the CRM entity. Email provenance points to the CRM record and the billing payload keeps its original casing.                                                                                                           |
| Company review                 | A changed company name with the same domain gets `REVIEW` at confidence `0.7538`. The demo approves the known synthetic rename with the current record and entity versions. The case becomes `RESOLVED`, the company has two linked records, and the original machine evidence is preserved. |
| Mistaken merge and reversal    | An intentional merge moves the second Person's record and marks its original entity `MERGED`. A split with the original merge event restores the entity, record, and raw payload. The target keeps both original records and its history retains both operations.                            |
| Asynchronous batch             | The worker completes the job as `SUCCEEDED` with two successful records. The duplicate links to the CRM entity with `AUTO_MATCH`, and the new Person gets `NO_MATCH`.                                                                                                                        |
| Tenant isolation               | The second tenant submits the same Person and gets zero candidates and its own entity. It can read its own entity. Requests for the primary tenant's entity, review, and job each return `404`.                                                                                              |

## Matching quality on the golden dataset

Run `npm run evaluate:golden` after installing dependencies and configuring the
test database. The [golden evaluation guide](week2-day7-quality-powershell.md)
gives the setup commands, report location, and metric definitions. The Day 7
run evaluated eight labeled synthetic pairs using the authenticated API and
`rules-0.1.0`.

| Metric                                          | Day 7 result |
| ----------------------------------------------- | -----------: |
| Automatic match precision                       |   3/3 (100%) |
| Automatic match recall                          |    3/5 (60%) |
| False-positive rate                             |     0/3 (0%) |
| Review rate                                     |    2/8 (25%) |
| Automatic resolution rate, including `NO_MATCH` |    6/8 (75%) |
| Candidate recall for same-identity pairs        |    4/5 (80%) |

Of the five same-identity pairs, three matched automatically, one went to
review, and one missed at blocking. In that blocking miss, a phone number
changed and the second record omitted accents from the person's name. The
eight authored pairs measure behavior on those scenarios. Production accuracy
would require a representative labeled dataset.
