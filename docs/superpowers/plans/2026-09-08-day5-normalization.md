# Day 5 Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and persist deterministic `normalization-v1` values for Person and Company source records while preserving immutable raw source truth.

**Architecture:** A pure `@resolve/normalization` workspace package owns field and record normalizers. The NestJS ingestion service calls the package inside its existing transaction and writes the returned payload, version, and blocking projections to existing `SourceRecord` columns.

**Tech Stack:** Node.js 24+, TypeScript 5.9, Jest 29, `libphonenumber-js`, NestJS 11, Prisma 7, PostgreSQL

**Spec:** `docs/superpowers/specs/2026-09-08-day5-normalization-design.md`

## Global Constraints

- The normalization version is exactly `normalization-v1`.
- Raw payloads and `SourceRecordVersion` rows are immutable source truth.
- Normalization is deterministic, synchronous, conservative, and performs no network calls.
- The package has no NestJS, Prisma, PostgreSQL, Redis, or BullMQ dependency.
- Invalid or missing optional values produce `null` evidence.
- Email local-part case, dots, and plus-tags are preserved.
- Phone normalization never guesses a default country.
- Unicode text uses NFKC and preserves diacritics and non-Latin scripts.
- Existing `/v1/records` request and response shapes remain unchanged.
- No Prisma migration is added because all required columns and indexes already exist.
- Matching, scoring, decisions, entity linking, canonicalization, and batch normalization remain out of scope.
- Do not commit any Day 5 files until the user has reviewed the completed implementation and explicitly authorizes a commit.

---

### Task 1: Normalization package and scalar field rules

**Files:**

- Create: `packages/normalization/package.json`
- Create: `packages/normalization/tsconfig.json`
- Create: `packages/normalization/tsconfig.build.json`
- Create: `packages/normalization/src/text.ts`
- Create: `packages/normalization/src/domain.ts`
- Create: `packages/normalization/src/email.ts`
- Create: `packages/normalization/src/name.ts`
- Create: `packages/normalization/src/phone.ts`
- Create: `packages/normalization/src/index.ts`
- Create: `packages/normalization/test/scalar-normalizers.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `jest.config.cjs`

**Interfaces:**

- Consumes: `libphonenumber-js` `parsePhoneNumberFromString` and `isSupportedCountry`.
- Produces: `normalizeText`, `normalizeName`, `normalizeDomain`, `normalizeEmail`, and `normalizePhone`, each returning `string | null`.

- [ ] **Step 1: Create package configuration and install the phone dependency**

`packages/normalization/package.json`:

```json
{
  "name": "@resolve/normalization",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "libphonenumber-js": "^1.12.0"
  },
  "type": "module"
}
```

`packages/normalization/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "." },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`packages/normalization/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "exclude": ["test", "**/*.spec.ts"]
}
```

Run:

```powershell
npm install
```

Expected: npm registers the new workspace, resolves `libphonenumber-js`, and updates `package-lock.json`.

- [ ] **Step 2: Write failing scalar normalizer tests**

`packages/normalization/test/scalar-normalizers.spec.ts` must import from `../src/index.js` and include literal expectations:

```ts
describe('text and name normalization', () => {
  it.each([null, undefined, '', '   ', '\u00a0'])('maps %p to null', (value) => {
    expect(normalizeText(value)).toBeNull();
  });

  it('uses NFKC, collapses Unicode whitespace, and preserves punctuation', () => {
    expect(normalizeName('  Ｏ’ＮＥＩＬ\tJosé  李  ')).toBe('o’neil josé 李');
  });
});

describe('email normalization', () => {
  it('preserves local-part case, dots, and plus-tags while normalizing the domain', () => {
    expect(normalizeEmail(' User.Name+sales@EXAMPLE.COM ')).toBe('User.Name+sales@example.com');
  });

  it.each(['missing-at.example.com', '.user@example.com', 'a..b@example.com'])(
    'rejects invalid email %s',
    (value) => expect(normalizeEmail(value)).toBeNull(),
  );
});

describe('domain normalization', () => {
  it.each([
    ['HTTPS://WWW.Example.COM/', 'example.com'],
    ['www.example.com.', 'example.com'],
    ['münich.example', 'xn--mnich-kva.example'],
  ])('normalizes %s', (value, expected) => {
    expect(normalizeDomain(value)).toBe(expected);
  });

  it.each([
    'ftp://example.com',
    'https://example.com/path',
    'https://user@example.com',
    'example.com:443',
    '127.0.0.1',
    'localhost',
  ])('rejects non-company-domain value %s', (value) => {
    expect(normalizeDomain(value)).toBeNull();
  });
});

describe('phone normalization', () => {
  it('normalizes Ethiopian national format with country context', () => {
    expect(normalizePhone('0911 223 344', 'et')).toBe('+251911223344');
  });

  it('normalizes an international number without country context', () => {
    expect(normalizePhone('+251 911 223 344')).toBe('+251911223344');
  });

  it.each([
    ['0911 223 344', undefined],
    ['123', 'ET'],
    ['', 'ET'],
  ] as const)('returns null for ambiguous or invalid phone %s', (value, country) => {
    expect(normalizePhone(value, country)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the scalar tests and verify RED**

Run:

```powershell
npm test -- packages/normalization/test/scalar-normalizers.spec.ts
```

Expected: FAIL because `packages/normalization/src/index.ts` and its exports do not exist.

- [ ] **Step 4: Implement the minimal scalar normalizers**

Implement `normalizeText` with `value.normalize('NFKC').trim().replace(/\s+/gu, ' ')`; implement `normalizeName` by lowercasing its non-null result.

Implement `normalizeDomain` by distinguishing an HTTP/HTTPS URL from a bare host, rejecting all disallowed URL parts, reading `URL.hostname` for IDN-to-ASCII conversion, stripping one `www.` and trailing dots, then validating:

```ts
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function isCompanyHostname(hostname: string): boolean {
  if (hostname.length > 253 || !hostname.includes('.')) return false;
  return hostname.split('.').every((label) => DNS_LABEL.test(label));
}
```

Implement `normalizeEmail` by splitting at the only `@`, applying the documented local-part rules, normalizing the domain with `normalizeDomain`, and enforcing the 320-character result limit.

Implement `normalizePhone` with supported uppercase ISO country narrowing and:

```ts
const parsed = prepared.startsWith('+')
  ? parsePhoneNumberFromString(prepared)
  : countryCode
    ? parsePhoneNumberFromString(prepared, countryCode)
    : undefined;
return parsed?.isValid() === true ? parsed.number : null;
```

Export all public functions and `NormalizableValue` from `src/index.ts`.

Add `^@resolve/normalization$` to the Jest module mapper and insert normalization before the API in root `build` and `typecheck` scripts.

- [ ] **Step 5: Run scalar tests and package checks and verify GREEN**

Run:

```powershell
npm test -- packages/normalization/test/scalar-normalizers.spec.ts
npm run typecheck -w @resolve/normalization
npm run build -w @resolve/normalization
```

Expected: all commands exit 0 and every scalar test passes.

- [ ] **Step 6: Record the review checkpoint**

Do not commit. Confirm `git status --short` contains only the approved Day 5 package, configuration, lockfile, spec, and plan changes.

---

### Task 2: Company, address, and record-level normalization

**Files:**

- Create: `packages/normalization/src/company.ts`
- Create: `packages/normalization/src/address.ts`
- Create: `packages/normalization/src/record.ts`
- Create: `packages/normalization/test/structured-normalizers.spec.ts`
- Modify: `packages/normalization/src/index.ts`

**Interfaces:**

- Consumes: scalar functions from Task 1.
- Produces: `NormalizedCompanyName`, `NormalizedAddress`, `NormalizedRecord`, `normalizeCompanyName`, `normalizeAddress`, `normalizeRecord`, and `NORMALIZATION_VERSION`.

- [ ] **Step 1: Write failing structured normalizer tests**

`packages/normalization/test/structured-normalizers.spec.ts`:

```ts
it('retains the full company name and separates a terminal legal suffix', () => {
  expect(normalizeCompanyName(' Acme Trading PLC ')).toEqual({
    full: 'acme trading plc',
    base: 'acme trading',
    legal_suffix: 'plc',
  });
});

it.each([
  'Ltd.',
  'LIMITED',
  'llc',
  'Inc.',
  'incorporated',
  'Corp.',
  'corporation',
  'Co.',
  'company',
])('recognizes %s as a terminal legal suffix', (suffix) =>
  expect(normalizeCompanyName(`Example ${suffix}`)?.legal_suffix).not.toBeNull(),
);

it('normalizes address components without moving values between fields', () => {
  expect(
    normalizeAddress({
      line1: '  10 MAIN ST. ',
      line2: '',
      city: ' ADDIS   ABABA ',
      region: 'ĀDDIS',
      postal_code: ' ab-12 ',
      country: ' et ',
      ignored: 'source-only',
    }),
  ).toEqual({
    line1: '10 main st.',
    line2: null,
    city: 'addis ababa',
    region: 'āddis',
    postal_code: 'AB-12',
    country: 'ET',
  });
});

it('normalizes a person record and creates a code-point-safe name prefix', () => {
  const longName = `${'😀'.repeat(64)}X`;
  const result = normalizeRecord('person', {
    name: longName,
    email: 'User+tag@EXAMPLE.COM',
    phone: '0911 223 344',
    company: ' ACME PLC ',
    company_domain: 'WWW.ACME.EXAMPLE.',
    address: { country: 'et' },
    attributes: { keep: 'raw only' },
  });

  expect(result.normalization_version).toBe('normalization-v1');
  expect(result.normalized_name_prefix).toBe('😀'.repeat(64));
  expect(result.normalized_phone).toBe('+251911223344');
  expect(result.normalized_payload).toEqual({
    name: longName.toLowerCase(),
    email: 'User+tag@example.com',
    phone: '+251911223344',
    company: { full: 'acme plc', base: 'acme', legal_suffix: 'plc' },
    company_domain: 'acme.example',
    address: {
      line1: null,
      line2: null,
      city: null,
      region: null,
      postal_code: null,
      country: 'ET',
    },
  });
});

it('normalizes a company record and omits raw-only registration data', () => {
  expect(
    normalizeRecord('company', {
      name: ' Resolve Incorporated ',
      domain: 'https://www.resolve.example/',
      registration_id: ' RAW-123 ',
    }).normalized_payload,
  ).toEqual({
    name: { full: 'resolve incorporated', base: 'resolve', legal_suffix: 'incorporated' },
    domain: 'resolve.example',
    email: null,
    phone: null,
    address: null,
  });
});
```

- [ ] **Step 2: Run the structured tests and verify RED**

Run:

```powershell
npm test -- packages/normalization/test/structured-normalizers.spec.ts
```

Expected: FAIL because the structured exports do not exist.

- [ ] **Step 3: Implement company and address normalization**

Create the exact suffix set from the spec and inspect only the final token:

```ts
const LEGAL_SUFFIXES = new Set([
  'plc',
  'ltd',
  'limited',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
]);
```

`normalizeCompanyName` returns the full name, a base with terminal commas and whitespace removed, and the canonical suffix without its optional period. It retains the full value even when a suffix is found.

`normalizeAddress` reads only `line1`, `line2`, `city`, `region`, `postal_code`, and `country`; non-string values become `null`. It returns `null` when every result component is null.

- [ ] **Step 4: Implement record normalization**

Define `NORMALIZATION_VERSION` and the three public result interfaces exactly as specified. Read the raw address country only when it is a string, pass it to `normalizePhone`, and build fixed-key Person and Company payloads.

Create the prefix without splitting surrogate pairs:

```ts
function namePrefix(value: string | null): string | null {
  return value === null ? null : Array.from(value).slice(0, 64).join('');
}
```

Return projections from the same local normalized variables used in the payload. Export every public type, constant, and function through `src/index.ts`.

- [ ] **Step 5: Run all package tests and checks and verify GREEN**

Run:

```powershell
npm test -- packages/normalization
npm run typecheck -w @resolve/normalization
npm run build -w @resolve/normalization
```

Expected: all commands exit 0 and scalar plus structured tests pass.

- [ ] **Step 6: Record the review checkpoint**

Do not commit. Use `git diff --check` and confirm it reports no whitespace errors.

---

### Task 3: Persist normalization during record ingestion

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/api/src/records/record-ingestion.service.ts`
- Create: `tests/integration/day5-normalization.integration.ts`
- Modify: `tests/integration/day4-api.integration.ts`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: `normalizeRecord(entityType, rawData): NormalizedRecord`.
- Produces: atomic create/update/refresh persistence in the existing `POST /v1/records` flow.

- [ ] **Step 1: Write failing Day 5 integration tests**

Create an isolated-schema integration suite following the setup and teardown in `tests/integration/day4-api.integration.ts`. Bootstrap one tenant, one `records:write` API key, and one source.

The create test submits raw mixed-case and Unicode values, then uses SQL to assert:

```ts
expect(stored.rows[0]).toEqual({
  raw_payload: rawData,
  normalized_payload: {
    name: 'josé 李',
    email: 'User+tag@example.com',
    phone: '+251911223344',
    company: { full: 'acme trading plc', base: 'acme trading', legal_suffix: 'plc' },
    company_domain: 'acme.example',
    address: {
      line1: null,
      line2: null,
      city: 'addis ababa',
      region: null,
      postal_code: null,
      country: 'ET',
    },
  },
  normalization_version: 'normalization-v1',
  normalized_email: 'User+tag@example.com',
  normalized_phone: '+251911223344',
  company_domain: 'acme.example',
  normalized_name_prefix: 'josé 李',
});
```

Also assert the version-one `raw_payload` equals the submitted data object.

Add a changed-payload test that expects `version: 2`, two immutable raw version rows, and normalized fields derived from version two.

Add a current-version unchanged test that records `updated_at`, retries the same logical payload with reordered keys, and expects `operation: 'UNCHANGED'`, one raw version, and the same `updated_at`.

Add a missing/legacy normalization test that clears only derived fields with SQL, retries the same raw object, and expects `UNCHANGED`, version one, one history row, and refreshed `normalization-v1` fields.

Add a Company test proving `data.domain` maps to `company_domain` and address country supplies phone context.

- [ ] **Step 2: Run the Day 5 integration suite and verify RED**

Run:

```powershell
docker compose up -d --wait postgres
npm run test:integration -- tests/integration/day5-normalization.integration.ts
```

Expected: FAIL because ingestion still stores null normalized fields.

- [ ] **Step 3: Add the package dependency and normalization mapping**

Add `"@resolve/normalization": "^0.1.0"` to `apps/api/package.json` and refresh the lockfile with `npm install`.

In `record-ingestion.service.ts`, compute the result once after determining database entity type:

```ts
const normalized = normalizeRecord(input.entity_type, rawData);
const normalizedData = {
  normalizedPayload: normalized.normalized_payload as Prisma.InputJsonObject,
  normalizationVersion: normalized.normalization_version,
  normalizedEmail: normalized.normalized_email,
  normalizedPhone: normalized.normalized_phone,
  companyDomain: normalized.company_domain,
  normalizedNamePrefix: normalized.normalized_name_prefix,
};
```

Spread `normalizedData` into new-record creates and changed-record updates instead of clearing derived fields.

For an unchanged raw hash, return directly only when
`existing.normalizationVersion === NORMALIZATION_VERSION`. Otherwise update
only `normalizedData`, then return `UNCHANGED` with version and raw state
untouched.

- [ ] **Step 4: Replace the superseded Day 4 clearing assertion**

In `tests/integration/day4-api.integration.ts`, replace the assertion that a changed payload clears normalization. Assert instead that the changed record stores:

```ts
expect(normalized.rows[0]).toEqual({
  normalized_payload: {
    name: 'abdulkerim h.',
    email: null,
    phone: null,
    company: null,
    company_domain: null,
    address: {
      line1: null,
      line2: null,
      city: 'addis ababa',
      region: null,
      postal_code: null,
      country: 'ET',
    },
  },
  normalization_version: 'normalization-v1',
});
```

- [ ] **Step 5: Run ingestion integration tests and verify GREEN**

Run:

```powershell
npm run test:integration -- tests/integration/day5-normalization.integration.ts
npm run test:integration -- tests/integration/day4-api.integration.ts
npm run typecheck -w @resolve/api
```

Expected: all commands exit 0. Day 5 persistence behavior passes and Day 4 authentication, idempotency, tenant isolation, concurrency, raw history, and API response behavior remain green.

- [ ] **Step 6: Record the review checkpoint**

Do not commit. Confirm no Prisma schema or migration file changed.

---

### Task 4: Documentation and full repository verification

**Files:**

- Modify: `docs/normalization/normalization-v1.md`
- Modify: `docs/architecture/overview.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-08-day5-normalization.md`

**Interfaces:**

- Consumes: completed package and ingestion behavior from Tasks 1-3.
- Produces: synchronized operator/developer documentation and verified review-ready Day 5 changes.

- [ ] **Step 1: Update normalization policy documentation**

Replace the Day 5 future-tense sentence in `docs/normalization/normalization-v1.md` with the implemented field rules, fixed payload shapes, version-refresh behavior, legal suffix vocabulary, invalid-input behavior, and explicit raw-data guarantee from the approved spec.

- [ ] **Step 2: Update architecture and README**

Add `packages/normalization` to the architecture ownership paragraph and repository tree. Update the current milestone to Week 1 Days 1-5. Explain that ingestion now persists deterministic `normalization-v1` fields alongside unchanged raw history.

Correct the damaged `entity_record_links` and missing-backtick formatting in the existing persistence-table list while editing `docs/architecture/overview.md`.

- [ ] **Step 3: Format the repository**

Run:

```powershell
npm run format
```

Expected: Prettier exits 0 and only formats repository-owned text and code.

- [ ] **Step 4: Run focused and full verification**

Run:

```powershell
npm run prisma:validate
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
docker compose config
```

Expected: every command exits 0 with no test failures or lint warnings.

- [ ] **Step 5: Review the complete diff**

Run:

```powershell
git diff --check
git status --short
git diff --stat
git diff -- packages/normalization apps/api/src/records tests/integration docs README.md package.json
```

Expected: no whitespace errors, no secrets, no generated build output, no migration, no unrelated changes, and no normalization behavior beyond the approved spec.

- [ ] **Step 6: Leave the implementation for user review**

Do not commit or push. Give the user a concise implementation summary plus detailed PowerShell instructions for automated and manual API/database testing. Wait for explicit authorization before committing.
