# Week 2 Day 1 Matching Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic field comparators and versioned Person and Company feature extraction with structured contradiction evidence.

**Architecture:** Add a pure `@resolve/matching` workspace package. Scalar and structured comparators accept normalized values, feature extraction returns typed `features-v1` evidence, and no NestJS, database, scoring, or decision code enters this milestone.

**Tech Stack:** TypeScript 5.9, Node.js 24, Jest 29, npm workspaces, Prettier, ESLint, Docker.

**Spec:** `docs/superpowers/specs/2026-09-09-week2-day1-matching-features-design.md`

## Global Constraints

- Preserve raw source payloads. Feature extraction must not mutate either input.
- Keep each similarity in the inclusive range 0 through 1.
- Treat null, undefined, empty, and whitespace-only strings as missing evidence.
- Use `FEATURE_VERSION = 'features-v1'` for every extraction result.
- Keep comparison logic free of NestJS, Prisma, Redis, logging, and network calls.
- Use warning severity for email, phone, domain, and country conflicts.
- Use blocking severity for conflicting present Company registration IDs.
- Do not add scoring, decisions, persistence, entity linking, or HTTP behavior.
- Leave all work uncommitted until the user reviews it. The checkpoints below record intended logical commits for later use.

---

### Task 1: Matching workspace and exact/edit comparators

**Files:**

- Create: `packages/matching/package.json`
- Create: `packages/matching/tsconfig.json`
- Create: `packages/matching/tsconfig.build.json`
- Create: `packages/matching/src/comparable-string.ts`
- Create: `packages/matching/src/exact.ts`
- Create: `packages/matching/src/edit-similarity.ts`
- Create: `packages/matching/src/index.ts`
- Test: `packages/matching/test/scalar-comparators.spec.ts`
- Modify: `jest.config.cjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Produces: `ComparableString = string | null | undefined`
- Produces: `presentString(value): string | null`
- Produces: `exactEquality(left, right): boolean | null`
- Produces: `editSimilarity(left, right): number | null`

- [ ] **Step 1: Add workspace scaffolding and failing tests**

Create a private ESM workspace package with `build` and `typecheck` scripts that mirror `packages/normalization`. Add dependencies on `@resolve/contracts` and `@resolve/normalization` at `^0.1.0`.

Register `@resolve/matching` in the root Jest mapper. Add its build before API and worker builds in root `build` and `typecheck` scripts.

Start `scalar-comparators.spec.ts` with these cases:

```ts
import { editSimilarity, exactEquality } from '../src/index.js';

describe('exactEquality', () => {
  it.each([null, undefined, '', '   '])('returns null when one value is %p', (missing) => {
    expect(exactEquality(missing, 'value')).toBeNull();
    expect(exactEquality('value', missing)).toBeNull();
  });

  it('distinguishes normalized equality from inequality', () => {
    expect(exactEquality('User@example.com', 'User@example.com')).toBe(true);
    expect(exactEquality('User@example.com', 'user@example.com')).toBe(false);
  });
});

describe('editSimilarity', () => {
  it.each([
    ['kitten', 'sitting', 4 / 7],
    ['café', 'cafe', 0.75],
    ['李', '李', 1],
    ['a', 'b', 0],
  ] as const)('compares %s and %s', (left, right, expected) => {
    expect(editSimilarity(left, right)).toBeCloseTo(expected, 10);
    expect(editSimilarity(right, left)).toBeCloseTo(expected, 10);
  });

  it('returns null for missing input', () => {
    expect(editSimilarity('', 'value')).toBeNull();
    expect(editSimilarity(null, 'value')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
npm.cmd install
npm.cmd run test -- packages/matching/test/scalar-comparators.spec.ts
```

Expected: Jest fails because `exactEquality` and `editSimilarity` do not exist.

- [ ] **Step 3: Implement missing-value handling and exact equality**

Use this contract in `comparable-string.ts`:

```ts
export type ComparableString = string | null | undefined;

export function presentString(value: ComparableString): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value;
}
```

Use this contract in `exact.ts`:

```ts
import { presentString, type ComparableString } from './comparable-string.js';

export function exactEquality(left: ComparableString, right: ComparableString): boolean | null {
  const presentLeft = presentString(left);
  const presentRight = presentString(right);
  if (presentLeft === null || presentRight === null) return null;
  return presentLeft === presentRight;
}
```

- [ ] **Step 4: Implement Unicode Levenshtein similarity**

Convert both strings with `Array.from`, keep the shorter string on the matrix row, initialize `previous` as `0..shorter.length`, and fill `current` with insertion, deletion, and substitution minima. Return:

```ts
const denominator = Math.max(leftPoints.length, rightPoints.length);
return Math.max(0, Math.min(1, 1 - distance / denominator));
```

Return `null` before allocating rows when either input is missing. Return `1` for equal present strings.

- [ ] **Step 5: Export and verify Task 1**

Export the public functions and types from `src/index.ts`, then run:

```powershell
npm.cmd run test -- packages/matching/test/scalar-comparators.spec.ts
npm.cmd run typecheck -w @resolve/matching
```

Expected: focused tests and matching-package typecheck pass.

- [ ] **Step 6: Review checkpoint**

Leave Task 1 uncommitted. Intended later commit: `feat: add deterministic scalar comparators`.

---

### Task 2: Jaro-Winkler, token, domain, and address comparison

**Files:**

- Create: `packages/matching/src/jaro-winkler.ts`
- Create: `packages/matching/src/token-similarity.ts`
- Create: `packages/matching/src/domain.ts`
- Create: `packages/matching/src/address.ts`
- Modify: `packages/matching/src/index.ts`
- Modify: `packages/matching/test/scalar-comparators.spec.ts`
- Test: `packages/matching/test/address.spec.ts`

**Interfaces:**

- Consumes: `ComparableString`, `presentString`, `exactEquality`
- Produces: `jaroWinklerSimilarity(left, right): number | null`
- Produces: `tokenSimilarity(left, right): number | null`
- Produces: `domainEquality(left, right): boolean | null`
- Produces: `addressTokenSimilarity(left, right): number | null`
- Produces: `addressCountryEquality(left, right): boolean | null`

- [ ] **Step 1: Write failing Jaro-Winkler and token tests**

Add:

```ts
import { domainEquality, jaroWinklerSimilarity, tokenSimilarity } from '../src/index.js';

expect(jaroWinklerSimilarity('martha', 'marhta')).toBeCloseTo(0.961_111, 5);
expect(jaroWinklerSimilarity('dixon', 'dicksonx')).toBeCloseTo(0.813_333, 5);
expect(jaroWinklerSimilarity('李明', '李明')).toBe(1);
expect(jaroWinklerSimilarity(null, 'name')).toBeNull();

expect(tokenSimilarity('acme trading', 'trading acme')).toBe(1);
expect(tokenSimilarity('acme acme trading', 'acme trading')).toBe(1);
expect(tokenSimilarity('blue nile', 'rift valley')).toBe(0);
expect(tokenSimilarity('café 李', '李 café')).toBe(1);
expect(tokenSimilarity('   ', 'acme')).toBeNull();

expect(domainEquality('example.com', 'example.com')).toBe(true);
expect(domainEquality('a.example', 'b.example')).toBe(false);
expect(domainEquality(null, 'example.com')).toBeNull();
```

Add focused table-driven regression cases to the same scalar suite:

- Jaro-Winkler symmetry: compare both directions for `martha`/`marhta`,
  `dixon`/`dicksonx`, repeated characters `aab`/`aba`, Unicode
  `😀ab`/`😀ba`, and disjoint unequal-length inputs `a`/`xyz`.
- Inclusive Jaro-Winkler bounds: assert scores are at least zero and at most
  one, including `a`/`b` = `0`, `李明`/`李明` = `1`, and
  `martha`/`marhta` = `173 / 180`.
- Four-code-point prefix cap: `abcdefx`/`abcdefy` and
  `😀😃😄😁abx`/`😀😃😄😁aby` each equal `33 / 35`. Their Jaro score is
  `19 / 21`; boosting all six shared code points would give a different result.
  Also assert `😀abx`/`😀aby` = `53 / 60` to distinguish three prefix code
  points from four UTF-16 units. Check both directions.
- The `0.7` adjustment threshold: `abxxxx`/`abyyyy` = `5 / 9` without a
  prefix boost; `ab`/`abxxxxxxxxxxxxxxxxxx` = `19 / 25` at the threshold
  (two matches, lengths two and twenty, Jaro `7 / 10`); and
  `abcx`/`abcy` = `53 / 60` above it (Jaro `5 / 6`). Check both directions.
- Code-point edit distance: extend the Task 1 table with `😀`/`😃` = `0`
  in both directions; a UTF-16-unit implementation incorrectly returns `0.5`.
- Token punctuation: `acme,`/`acme` = `0` and
  `acme, trading`/`acme trading` = `1 / 3`.

Use these independently derived expected values with numeric tolerances;
do not compute expected scores by copying the comparator algorithm.

- [ ] **Step 2: Run the scalar test and confirm RED**

Run:

```powershell
npm.cmd run test -- packages/matching/test/scalar-comparators.spec.ts
```

Expected: Jest fails on the new missing exports.

- [ ] **Step 3: Implement Jaro-Winkler**

Use Unicode code-point arrays. Mark matched positions in two boolean arrays,
count matches inside `max(0, floor(maxLength / 2) - 1)`, count half the matched
out-of-order characters as transpositions, and calculate Jaro:

```ts
const jaro =
  (matches / leftLength + matches / rightLength + (matches - transpositions) / matches) / 3;
```

Count at most four shared prefix code points. Apply
`jaro + prefixLength * 0.1 * (1 - jaro)` only when `jaro >= 0.7`, then clamp.

- [ ] **Step 4: Implement token and domain comparison**

Build token sets with:

```ts
const tokens = new Set(Array.from(value.split(/\s+/u)).filter((token) => token.length > 0));
```

Count the intersection and divide by the union size. Return `null` if either
input is missing. Implement `domainEquality` as a named wrapper around
`exactEquality` without additional transformations.

- [ ] **Step 5: Write failing address tests**

Create `address.spec.ts`:

```ts
import { addressCountryEquality, addressTokenSimilarity } from '../src/index.js';

const left = {
  line1: '10 bole road',
  line2: null,
  city: 'addis ababa',
  region: null,
  postal_code: '1000',
  country: 'ET',
};
const reordered = {
  line1: 'bole road 10',
  line2: null,
  city: 'addis ababa',
  region: null,
  postal_code: '1000',
  country: 'ET',
};

expect(addressTokenSimilarity(left, reordered)).toBe(1);
expect(addressCountryEquality(left, reordered)).toBe(true);
expect(addressTokenSimilarity(null, reordered)).toBeNull();
expect(addressCountryEquality({ country: 'ET' }, { country: 'KE' })).toBe(false);
expect(addressTokenSimilarity({ unexpected: 'value' }, reordered)).toBeNull();
```

- [ ] **Step 6: Implement structured address comparison and verify Task 2**

Accept `unknown` inputs. Narrow non-array objects, read the six approved fields
in fixed order, keep present string values, and join them with one space before
calling `tokenSimilarity`. Read `country` separately for exact equality.

Run:

```powershell
npm.cmd run test -- packages/matching/test/scalar-comparators.spec.ts packages/matching/test/address.spec.ts
npm.cmd run typecheck -w @resolve/matching
```

Expected: both suites and typecheck pass.

- [ ] **Step 7: Review checkpoint**

Leave Task 2 uncommitted. Combine it with Task 1 in the intended later commit
`feat: add deterministic field comparators`.

---

### Task 3: Typed Person and Company feature extraction

**Files:**

- Create: `packages/matching/src/features.ts`
- Create: `packages/matching/src/entity-type-mismatch.error.ts`
- Create: `packages/matching/src/feature-extractor.ts`
- Modify: `packages/matching/src/index.ts`
- Test: `packages/matching/test/feature-extractor.spec.ts`

**Interfaces:**

- Consumes: all Task 1 and Task 2 comparators
- Consumes: `EntityType` and `ContradictionEvidence` from `@resolve/contracts`
- Consumes: `normalizeText` from `@resolve/normalization`
- Produces: `ComparisonRecord`, Person and Company feature interfaces
- Produces: `FeatureExtractionResult` discriminated union
- Produces: `extractFeatures(left, right): FeatureExtractionResult`

- [ ] **Step 1: Define typed result shapes and failing Person tests**

Define `FEATURE_VERSION = 'features-v1' as const`. Person features contain:

```ts
interface PersonFeatures {
  email_exact: boolean | null;
  phone_exact: boolean | null;
  name_edit_similarity: number | null;
  name_jaro_winkler_similarity: number | null;
  company_name_token_similarity: number | null;
  company_domain_exact: boolean | null;
  address_token_similarity: number | null;
  country_exact: boolean | null;
}
```

Test two complete normalized Person payloads. Assert exact email, exact phone,
both name similarities, company-base token similarity, domain equality,
address similarity, country equality, the version, and an empty contradiction
list. Add a sparse case and assert every unavailable feature equals `null`.

Add a Person company-domain mismatch and assert its warning retains
`code: 'COMPANY_DOMAIN_CONFLICT'` and `field: 'company_domain'`.
Test malformed normalized fields (non-string scalars, malformed company
base, and a non-object address) as unavailable evidence, with the complete
null-filled Person shape.

- [ ] **Step 2: Run the Person tests and confirm RED**

Run:

```powershell
npm.cmd run test -- packages/matching/test/feature-extractor.spec.ts
```

Expected: Jest fails because the feature types and extractor do not exist.

- [ ] **Step 3: Implement Person extraction and warning contradictions**

Create safe readers for strings, records, normalized company `base`, and
addresses. Build features in the interface order. Append warning evidence in
this fixed order when the matching exact feature equals `false`:

```ts
const warnings = [
  ['EMAIL_CONFLICT', 'email', 'Both records contain different normalized email values.'],
  ['PHONE_CONFLICT', 'phone', 'Both records contain different normalized phone values.'],
  [
    'COMPANY_DOMAIN_CONFLICT',
    'company_domain',
    'Both records contain different normalized company domain values.',
  ],
  ['COUNTRY_CONFLICT', 'address.country', 'Both records contain different country values.'],
] as const;
```

Each emitted object uses `severity: 'warning'`. Do not include compared values
in messages.

- [ ] **Step 4: Define Company features and failing contradiction tests**

Define:

```ts
interface CompanyFeatures {
  email_exact: boolean | null;
  phone_exact: boolean | null;
  company_name_edit_similarity: number | null;
  company_name_jaro_winkler_similarity: number | null;
  company_name_token_similarity: number | null;
  domain_exact: boolean | null;
  address_token_similarity: number | null;
  country_exact: boolean | null;
  registration_id_exact: boolean | null;
}
```

Test equal company bases with different legal suffixes, equal normalized
domains, reordered address tokens, and registration IDs `ET-1001` and
`et-1001`. Assert `registration_id_exact` is true.

Add a conflict case with `ET-1001` and `ET-9009`. Assert the final
contradiction equals:

```ts
{
  code: 'REGISTRATION_ID_CONFLICT',
  field: 'registration_id',
  message: 'Both records contain different company registration identifiers.',
  severity: 'blocking',
}
```

Also test warning order for email, phone, domain, and country conflicts.

For Company domain conflicts assert `field: 'domain'`, while retaining the
shared `COMPANY_DOMAIN_CONFLICT` code and warning severity. Assert the full
ordered contradiction list, with the registration-ID blocker last.

Add a sparse Company table: an empty payload compared with another empty
payload, and with `{ name: { base: 'acme trading' } }`, in both directions.
Assert the entire result, including `features-v1`, Company entity type, all
nine Company feature keys set to `null`, and an empty contradiction list.

Add table-driven registration-ID preparation cases:

- NFKC: `ＥＴ-１００１` and `et-1001` compare equal.
- Outer whitespace: `\u2003 ET-1001 \t` and `et-1001` compare equal.
- Unicode whitespace collapse: `ET\t\u2003 1001` and `et 1001` compare equal.
- Punctuation preservation: `ET-1001` versus `ET1001`, and `ET/1001` versus
  `ET-1001`, remain unequal and emit the exact blocking contradiction.
- Internal token structure: `ET 1001` versus `ET1001` remains unequal and
  emits the exact blocking contradiction.

Assert no contradictions for equal prepared IDs and that the original raw
registration-ID values remain unchanged after extraction.

- [ ] **Step 5: Implement Company extraction**

Prepare present registration IDs with:

```ts
function prepareRegistrationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return normalizeText(value)?.toLowerCase() ?? null;
}
```

Compare the prepared values with `exactEquality`. Append Company warnings in
email, phone, domain, country order. Append the blocking registration-ID
contradiction last.

- [ ] **Step 6: Enforce entity-type invariants**

Keep contracts imports type-only. Check each serialized literal before its
enum-member assertion:

```ts
const PERSON_ENTITY_TYPE = 'person' satisfies `${EntityType.Person}` as EntityType.Person;
const COMPANY_ENTITY_TYPE = 'company' satisfies `${EntityType.Company}` as EntityType.Company;
```

Create `EntityTypeMismatchError extends Error`, set its `name`, and give it a
message that names the two entity types without including record data. Test
that `extractFeatures` throws when Person and Company inputs are mixed.

Clone no inputs and mutate no payload fields. Add a test that freezes both
inputs before extraction and confirms they remain equal to snapshots.

- [ ] **Step 7: Verify Task 3**

Run:

```powershell
npm.cmd run test -- packages/matching/test/feature-extractor.spec.ts
npm.cmd run test -- packages/matching/test
npm.cmd run typecheck -w @resolve/matching
```

Expected: feature tests, all matching tests, and typecheck pass.

- [ ] **Step 8: Review checkpoint**

Leave Task 3 uncommitted. Intended later commit:
`feat: add versioned matching feature extraction`.

---

### Task 4: Golden evidence, build packaging, documentation, and full verification

**Files:**

- Test: `packages/matching/test/golden-features.spec.ts`
- Modify: `tests/golden-dataset/mvp-v1.json`
- Modify: `Dockerfile`
- Modify: `README.md`
- Modify: `docs/architecture/overview.md`
- Format only: `tests/fixtures/day7-integration-records.json`
- Format only: `tests/integration/day7-checkpoint.integration.ts`
- Modify as generated: `package-lock.json`

**Interfaces:**

- Consumes: `normalizeRecord` and `extractFeatures`
- Produces: golden-data evidence coverage for `features-v1`
- Produces: build and runtime packaging for `@resolve/matching`

- [ ] **Step 1: Correct the golden phone context and write failing feature tests**

Add `"address": { "country": "ET" }` to `record_b` in
`person-email-phone-format-auto-match`. The national-format phone requires
country context under `normalization-v1`; keep the case ID, expected decision,
and rationale unchanged.

Read the golden file with `readFileSync` and normalize each record before
extraction. Assert these evidence facts:

```text
person-email-phone-format-auto-match:
  email_exact = true
  phone_exact = true
  contradictions = []

person-shared-name-no-match:
  name_jaro_winkler_similarity = 1
  EMAIL_CONFLICT and PHONE_CONFLICT warnings exist

company-abbreviation-domain-auto-match:
  company_name_token_similarity = 1
  domain_exact = true

company-registration-conflict-review:
  registration_id_exact = false
  REGISTRATION_ID_CONFLICT has blocking severity

company-common-name-country-no-match:
  COMPANY_DOMAIN_CONFLICT and COUNTRY_CONFLICT warnings exist
```

Do not assert final scores or decisions.

- [ ] **Step 2: Run the golden feature test and confirm RED**

Run:

```powershell
npm.cmd run test -- packages/matching/test/golden-features.spec.ts
```

Expected: the new assertions fail until any extractor gaps are corrected.

- [ ] **Step 3: Make the smallest extractor corrections and rerun**

Change only field readers, comparator calls, or contradiction mapping needed
by the failing evidence. Do not tune scores or add decision logic.

Run:

```powershell
npm.cmd run test -- packages/matching/test/golden-features.spec.ts
npm.cmd run test -- packages/matching/test
```

Expected: golden and package suites pass.

- [ ] **Step 4: Add Docker packaging**

Add `packages/matching/package.json` beside the other package-manifest copies
in both Docker dependency and runtime stages. Add:

```dockerfile
COPY --from=build /app/packages/matching/dist packages/matching/dist
```

beside the other package build-output copies.

- [ ] **Step 5: Update architecture and README**

Document:

- the pure `@resolve/matching` package boundary;
- the five comparator families and exact formulas;
- `features-v1` Person and Company fields;
- warning versus blocking contradiction codes;
- the boundary between evidence extraction and future scoring;
- the Week 2 Day 1 milestone status and test command.

Do not add Swagger documentation because no route changes.

- [ ] **Step 6: Clear the known formatting baseline**

Run Prettier only on the four files identified before this milestone:

```powershell
npx.cmd prettier --write docs/architecture/overview.md README.md tests/fixtures/day7-integration-records.json tests/integration/day7-checkpoint.integration.ts
```

Review those diffs and confirm they contain formatting changes only.

- [ ] **Step 7: Run complete verification**

Run each command and require exit code zero:

```powershell
npm.cmd run prisma:validate
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test
npm.cmd run test:integration
npm.cmd run build
docker compose build api worker
docker compose config --quiet
git diff --check
```

Expected totals must include the new matching suites. Record the exact suite
and test counts in the review handoff.

- [ ] **Step 8: Inspect final scope**

Run:

```powershell
git status --short --branch
git diff --stat
git diff -- packages/matching package.json package-lock.json jest.config.cjs Dockerfile README.md docs/architecture/overview.md
```

Confirm the branch contains no database migration, controller change, scoring
logic, decision logic, or generated secrets.

- [ ] **Step 9: Review checkpoint and later commit grouping**

Leave all files uncommitted for user review. After the user requests a commit,
split the approved work into these logical commits:

```text
chore: format Week 1 checkpoint files
feat: add deterministic matching comparators
feat: add versioned matching feature extraction
docs: document matching features v1
```

Merge the verified commits into `main`, push `main`, and remove the local
feature branch only after the user gives the commit instruction.
