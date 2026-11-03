# Week 2 Day 7: evaluate matching quality

This checkpoint runs the existing `mvp-v1` golden dataset through the real
authenticated NestJS HTTP API and PostgreSQL. Each pair gets a fresh tenant:
register CRM and billing sources, ingest record A, then resolve record B.
Only B's initial decision contributes to quality metrics. Seeding and replays
do not inflate the denominators. No human review decisions are applied.

`tests/golden-dataset/quality-v1.json` supplies separate identity labels and
explains their origin. These are authored synthetic scenarios, including a
person who changed phones and a company that renamed itself. They are not
verified real-world identities, and a `REVIEW` policy expectation is not a
ground-truth identity label. The original pairwise scorer expectations stay
in `mvp-v1.json`.

## 1. Use the checkout containing Day 7

Run PowerShell from a checkout containing Day 7. The commands below use the
main checkout:

```powershell
Set-Location -LiteralPath 'C:\Users\Admin\Desktop\Resolve Api'
node --version
npm.cmd --version
```

Use Node24+ and npm11+. Adjust the path if your checkout is elsewhere and keep
using the same checkout for the remaining commands. The implementation reused
the existing worktree and installed dependencies.

## 2. Start the existing dependencies

Open Docker Desktop if it is stopped, then run:

```powershell
docker compose up -d --wait --no-build --pull never postgres redis
if ($LASTEXITCODE -ne 0) { throw 'Local dependencies failed to start' }
$env:TEST_DATABASE_URL = 'postgresql://resolve:resolve@localhost:5432/resolve?schema=public'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm.cmd run prisma:generate
if ($LASTEXITCODE -ne 0) { throw 'Prisma generation failed' }
```

The prepared machine already has dependencies and container images. No
installation, API server terminal, API-key bootstrap, worker, or reset is
needed. Adjust the test URL if your local Compose credentials differ.
The evaluator uses `TEST_DATABASE_URL`, then `DATABASE_URL`, then the local
Compose URL. Use a development/test database whose user can create schemas.

## 3. Run the full golden evaluation

```powershell
npm.cmd run evaluate:golden
if ($LASTEXITCODE -ne 0) { throw 'Golden evaluation failed; inspect the test output and report' }
$reportPath = '.superpowers\sdd\week2-day7-quality\golden-report.json'
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
$report.metrics | ConvertTo-Json -Depth 10
```

Expected: one passing integration test and a JSON report. The test creates a
unique temporary schema, applies all migration SQL files in order, and checks
the real normalization/blocking/comparison/scoring/decision/persistence path.
It verifies entity links or open review cases, immutable source versions,
normalized values, persisted matching evidence, entity reads, and unchanged
replays. Teardown removes only the schema created by that run.

The report contains dataset/label SHA-256 hashes, policy weights/thresholds,
algorithm versions, per-case outcomes and contradictions, metric numerators
and denominators, and any baseline regressions. It contains no API keys or
database connection strings. The small report is overwritten on each run and
ignored by Git. A previous report is removed before starting an evaluation;
decision regressions are reported before the test fails.

## 4. Check the baseline and definitions

| Metric                    | Baseline   | Definition                                                     |
| ------------------------- | ---------- | -------------------------------------------------------------- |
| Automatic-match precision | 3/3 = 100% | Correct automatic links / all automatic links                  |
| Automatic-match recall    | 3/5 = 60%  | Correct automatic links / all labeled same-identity pairs      |
| False positives           | 0          | Different-identity pairs incorrectly linked automatically      |
| False-positive rate       | 0/3 = 0%   | False positives / all labeled different-identity pairs         |
| Review rate               | 2/8 = 25%  | REVIEW / evaluated incoming records                            |
| Auto-resolution rate      | 6/8 = 75%  | (AUTO_MATCH + NO_MATCH) / evaluated incoming records           |
| Positive candidate recall | 4/5 = 80%  | Same-identity pairs with a candidate / all same-identity pairs |

An undefined denominator produces `null`, not an accuracy claim. REVIEW is
an abstention: one positive pair is deferred and one negative pair is deferred.
Recall includes deferred positives in its denominator because they have not
been linked automatically. `false_negatives` counts positive `NO_MATCH`
outcomes only; `deferred_positives` is separate. Auto-resolution rate measures
automation volume, including incorrect NO_MATCH decisions; it is not accuracy.
Positive candidate recall is meaningful here because each isolated tenant has
only the one seeded candidate entity.

Expected confusion table:

| Synthetic identity     | AUTO_MATCH | REVIEW | NO_MATCH |
| ---------------------- | ---------: | -----: | -------: |
| Same identity (5)      |          3 |      1 |        1 |
| Different identity (3) |          0 |      1 |        2 |

Eight synthetic pairs cannot establish production precision or recall. The
zero-false-positive guard is a regression check for these scenarios only.

## 5. Inspect the blocking miss and safety decisions

```powershell
$report.cases | Format-Table id, same_identity, candidate_count, decision, pairwise_decision
$report.cases | Where-Object positive_blocking_miss | Format-List
$report.regressions
```

Expected: `regressions` is empty. `person-unicode-name-review` has zero
candidates and receives pipeline `NO_MATCH`, although direct pairwise scoring
would return `REVIEW`. Its phones differ and it has no email or location for
the indexed fallback. This is the single missed positive in the baseline.
Changing score thresholds cannot recover a record that never reaches scoring.

The original golden decision is therefore met end-to-end for seven of eight
pairs. A passing evaluator means the measured baseline and persistence checks
passed; it does not mean all original golden decision expectations are met.
The separate pipeline baseline explicitly preserves this known gap instead
of rewriting the original `REVIEW` expectation or counting it as a success.

`company-registration-conflict-review` is safely deferred despite its identical
name/domain: the trusted registration-ID contradiction blocks AUTO_MATCH.
`company-renamed-domain-review` is a positive pair deferred for human review.
The shared-name people and same-name companies in different countries produce
NO_MATCH. Three clear pairs link automatically.

Keep `rules-0.1.0`, the 0.72/0.92 thresholds, and the current blocking policy.
This run justifies documenting the recall gap; it does not justify removing
the indexed location requirement or lowering thresholds. A future blocking
change needs representative labeled examples, bounded indexed queries, and
more negative controls before changing the matching contract.

## 6. Verify repeatability

```powershell
$firstHash = (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash
npm.cmd run evaluate:golden
if ($LASTEXITCODE -ne 0) { throw 'Repeated evaluation failed' }
$secondHash = (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash
if ($firstHash -ne $secondHash) { throw 'Golden report changed between identical runs' }
```

The report omits ephemeral IDs and timestamps. Identical fixtures and policy
produce the same report, even though every run gets fresh tenants and a fresh
temporary schema.

## 7. Run the regression checks

For just the metric arithmetic and fixture contracts:

```powershell
npm.cmd run test -- tests/golden-dataset
```

Expected: two suites, five tests. These cover false positives, misses, review
deferrals, empty denominators, duplicate observations, invalid candidate counts,
and complete explained identity labels.

For the repository checks, run each command separately and stop on failure:

```powershell
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run test:integration
npm.cmd run build
```

The full integration command includes this evaluator automatically. CI already
runs that command. No new migration, dependency, environment requirement for
the API, or public endpoint is introduced by Day 7.

## 8. Confirm temporary data was cleaned up

```powershell
docker compose exec -T postgres psql -U resolve -d resolve -c "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'resolve_day7_quality_%';"
```

Expected: zero rows after a completed run. Existing application tenants and
records in other schemas remain available. Keep the generated JSON report
for review; no extra containers or dependency copies were created.
