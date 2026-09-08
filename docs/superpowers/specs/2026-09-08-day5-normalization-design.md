# Day 5 Normalization Design

## Purpose

Day 5 adds deterministic, versioned normalization for `person` and `company`
source records. Normalization creates comparable derived values without
changing the submitted payload or its version history.

This work stops at normalization and persistence. It does not create entities,
generate candidates, compare records, calculate scores, or make match
decisions.

## Chosen Approach

Create a standalone workspace package named `@resolve/normalization` and call
it synchronously from the existing single-record ingestion transaction.

The package contains pure TypeScript functions and has no NestJS, Prisma,
PostgreSQL, Redis, or BullMQ dependencies. The API maps the package result to
the existing `SourceRecord` derived columns.

Phone parsing uses `libphonenumber-js`. A maintained phone-number parser is
safer and more complete than a repository-specific table of country dialing
rules. Queue-based normalization is deferred because a single record is small,
deterministic work that should be complete when ingestion returns.

## Version Contract

The exact normalization version is:

```text
normalization-v1
```

Every successfully normalized source record stores that value in
`SourceRecord.normalizationVersion`. Any semantic change to the rules in this
document requires a different version identifier and updated tests.

## Package Boundary

The package exports these public types and functions:

```ts
export const NORMALIZATION_VERSION = 'normalization-v1' as const;

export type NormalizableValue = string | null | undefined;

export interface NormalizedCompanyName {
  full: string;
  base: string;
  legal_suffix: string | null;
}

export interface NormalizedAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
}

export interface NormalizedRecord {
  normalization_version: typeof NORMALIZATION_VERSION;
  normalized_payload: Record<string, unknown>;
  normalized_email: string | null;
  normalized_phone: string | null;
  company_domain: string | null;
  normalized_name_prefix: string | null;
}

export function normalizeText(value: NormalizableValue): string | null;
export function normalizeName(value: NormalizableValue): string | null;
export function normalizeEmail(value: NormalizableValue): string | null;
export function normalizePhone(
  value: NormalizableValue,
  country?: NormalizableValue,
): string | null;
export function normalizeDomain(value: NormalizableValue): string | null;
export function normalizeCompanyName(value: NormalizableValue): NormalizedCompanyName | null;
export function normalizeAddress(
  value: Record<string, unknown> | null | undefined,
): NormalizedAddress | null;
export function normalizeRecord(
  entityType: 'person' | 'company',
  rawData: Record<string, unknown>,
): NormalizedRecord;
```

Runtime guards treat values outside these declared input shapes as absent.
They do not stringify objects, arrays, booleans, or numbers into matching
evidence.

## Shared Text Rules

All text-oriented normalizers start with these operations:

1. Return `null` for `null`, `undefined`, empty, or whitespace-only input.
2. Apply Unicode NFKC normalization.
3. Trim outer whitespace.
4. Collapse consecutive Unicode whitespace to one ASCII space.

Field-specific rules run after these shared operations. Normalization preserves
diacritics and non-Latin scripts. It does not transliterate text or globally
strip punctuation.

JavaScript's locale-independent `toLowerCase()` is used where lowercasing is
required so results do not depend on the server's configured locale.

## Field Rules

### Name

Names use the shared text rules and lowercase the result. Internal punctuation,
including apostrophes and hyphens, remains present.

Examples:

| Raw                    | Normalized          |
| ---------------------- | ------------------- |
| ` ABDULKERIM   HASSEN` | `abdulkerim hassen` |
| `Ｏ’ＮＥＩＬ`          | `o’neil`            |
| `José Álvarez`         | `josé álvarez`      |

### Email

Email normalization:

1. Applies NFKC and trims outer whitespace.
2. Requires exactly one `@`, a non-empty local part no longer than 64
   characters, and a valid domain.
3. Uses a conservative ASCII dot-atom alphabet:
   letters, digits, `!`, `#`, `$`, `%`, `&`, `'`, `*`, `+`, `-`,
   `/`, `=`, `?`, `^`, `_`, `{`, `|`, `}`, `~`, and `.`.
4. Rejects local parts containing Unicode whitespace or control characters,
   starting or ending with a dot, or containing consecutive dots.
5. Preserves every accepted local-part character exactly, including case,
   dots, and plus-tags.
6. Rejects a completed normalized email longer than 320 characters.
7. Normalizes the domain through the domain normalizer.

`User.Name+sales@EXAMPLE.COM` becomes
`User.Name+sales@example.com`. Invalid or ambiguous input returns `null`.

### Phone

Phone normalization uses `libphonenumber-js` and returns a valid E.164 number.

- An international number beginning with `+` does not require country context.
- A national-format number requires a supported two-letter ISO country code.
- The record address's `country` field supplies that context.
- A parsed number must pass the library's validity check.
- Missing context, parse failure, or an invalid number returns `null`.

No guessed default country is allowed.

### Domain

Domain normalization accepts either a hostname or an HTTP/HTTPS URL. It:

1. Applies shared text preparation.
2. Rejects credentials, ports, query strings, fragments, and non-HTTP schemes.
3. Extracts the hostname from an HTTP/HTTPS URL only when the URL path is empty
   or `/`.
4. Converts an internationalized hostname to its ASCII form.
5. Lowercases the hostname.
6. Removes exactly one leading `www.`.
7. Removes trailing root dots.
8. Validates DNS label and total-length constraints.

A bare domain may have a trailing slash but may not contain another path.
IP addresses, `localhost`, single-label hosts, empty labels, and wildcard hosts
return `null` because the field is intended as company-domain evidence.

### Company Name

Company normalization returns the full normalized name plus a conservative
legal-suffix signal. The full value is never replaced by the base value.

The versioned suffix vocabulary is:

```text
plc
ltd
limited
llc
inc
incorporated
corp
corporation
co
company
```

Suffix recognition is case-insensitive after name normalization, accepts one
optional terminal period, and only considers the final token. The returned
`legal_suffix` uses the canonical lowercase token without a period. The `base`
removes that final suffix and trims remaining terminal commas or whitespace.
If removing the suffix would leave an empty base, the suffix is not extracted.

For example, `Acme Trading PLC` produces:

```json
{
  "full": "acme trading plc",
  "base": "acme trading",
  "legal_suffix": "plc"
}
```

### Address

Addresses are normalized by component. No component is copied into another
component, and components are not concatenated into a single address.

- `line1`, `line2`, `city`, and `region` use the name-style text rules.
- `postal_code` uses shared text preparation and uppercase conversion while
  preserving internal spaces and punctuation.
- `country` uses shared text preparation and uppercase conversion, and is kept
  only when it is exactly two ASCII letters.
- Unknown properties are ignored.
- If all recognized normalized components are `null`, the entire normalized
  address is `null`.

## Record-Level Output

`normalizeRecord` derives one payload based on `entity_type`.

For a person, `normalized_payload` contains these keys:

```json
{
  "name": "abdulkerim hassen",
  "email": "User@example.com",
  "phone": "+251911223344",
  "company": {
    "full": "acme trading plc",
    "base": "acme trading",
    "legal_suffix": "plc"
  },
  "company_domain": "example.com",
  "address": {
    "line1": null,
    "line2": null,
    "city": "addis ababa",
    "region": null,
    "postal_code": null,
    "country": "ET"
  }
}
```

For a company, `normalized_payload` contains `name` as a company-name object,
then `domain`, `email`, `phone`, and `address`.

Recognized keys are always present in `normalized_payload`; missing or invalid
scalar values are `null`, and an empty address is `null`. Opaque `attributes`
and `registration_id` are not copied into the derived comparable payload in
Day 5. They remain intact in raw source truth.

The indexed projections are derived from the same normalized values:

- `normalized_email`: normalized email for either entity type.
- `normalized_phone`: normalized phone for either entity type.
- `company_domain`: person's `company_domain` or company's `domain`.
- `normalized_name_prefix`: first 64 Unicode code points of the normalized
  person name or normalized company-name `full` value. Code-point slicing must
  not split surrogate pairs.

## Ingestion Data Flow

Normalization runs after authentication, validation, source lookup, and record
locking, but before the source-record create or update write.

### New record

The transaction writes:

- the submitted object to `rawPayload`,
- the same submitted object to `SourceRecordVersion.rawPayload`,
- the normalized object to `normalizedPayload`,
- `normalization-v1` to `normalizationVersion`, and
- all indexed normalized projections.

### Changed raw record

The transaction creates the next immutable raw version, updates `rawPayload`,
and atomically replaces all derived normalized fields with values computed from
the new raw object. It never temporarily clears them on a successful request.

### Unchanged raw record

If the raw hash is unchanged and the stored normalization version is already
`normalization-v1`, the operation stays `UNCHANGED` and performs no write.

If the raw hash is unchanged but normalization is missing or has a different
version, the transaction recomputes and replaces only the derived normalized
fields. The API operation remains `UNCHANGED`; `currentVersion`, `rawPayload`,
`rawPayloadHash`, and `SourceRecordVersion` rows remain unchanged.

This refresh behavior permits safe future backfills through ordinary
idempotent ingestion without pretending the customer sent new raw data.

## Raw-Data Guarantee

No normalizer mutates `rawData`. The API passes raw input to normalization as
read-only data and maps the returned object to separate database fields.

The raw JSON submitted by the caller remains the source of truth for auditing,
provenance, re-normalization, and future algorithm reproduction. A normalized
value is evidence derived from raw data, never a replacement for it.

## Failure Behavior

Invalid optional field values that survive runtime boundaries produce `null`
normalized evidence rather than fabricated values. Existing DTO validation
continues to reject malformed public request shapes before normalization.

Normalization is deterministic and local; it performs no network calls. An
unexpected normalization exception aborts the ingestion transaction, so raw
and normalized state cannot become partially committed.

No new public HTTP error shape is introduced. The existing `/v1/records`
response remains unchanged for backward compatibility.

## Database and Migration Impact

No schema migration is required. `SourceRecord` already has:

- `normalized_payload`,
- `normalization_version`,
- `normalized_email`,
- `normalized_phone`,
- `company_domain`, and
- `normalized_name_prefix`.

The Day 3 indexes already cover the Day 5 projections.

## Test Strategy

All production normalization behavior is developed test-first.

Package unit tests cover:

- `null`, `undefined`, empty, and whitespace-only input;
- Unicode NFKC compatibility characters;
- accented and non-Latin names;
- whitespace collapsing and conservative punctuation;
- email local-part case, dots, and plus-tag preservation;
- email domain lowercasing and invalid email rejection;
- international phone numbers;
- Ethiopian national numbers with `ET` context;
- national numbers without country context;
- invalid phone numbers;
- HTTP/HTTPS URLs, bare domains, one `www.`, trailing dots, and IDNs;
- invalid domain paths, ports, schemes, IPs, and single-label hosts;
- every legal-suffix rule and names without a recognized suffix;
- component-level address normalization and empty addresses;
- person and company normalized payload shapes; and
- 64-code-point prefixes containing non-BMP characters.

API integration/service tests cover:

- create persists raw and normalized values together;
- raw payload and version history preserve submitted values;
- changed raw input creates one raw version and recomputes normalization;
- unchanged current-version input performs no normalization write;
- unchanged legacy or missing normalization refreshes derived fields only;
- indexed projections agree with `normalizedPayload`; and
- person and company country context reaches phone normalization.

Repository verification includes package tests, API tests, type checking,
linting, formatting checks, and the full workspace build.

## Documentation Impact

Implementation updates:

- `docs/normalization/normalization-v1.md` with the exact operational rules;
- `docs/architecture/overview.md` with the normalization package and ingestion
  flow; and
- `README.md` only where package commands or documented behavior change.

Swagger does not change because the public request and response contracts do
not change.

## Explicitly Out of Scope

- Candidate generation and blocking queries
- Feature comparison
- Scoring and thresholds
- `AUTO_MATCH`, `REVIEW`, and `NO_MATCH` decisions
- Entity creation and record linking
- Canonicalization and survivorship
- Batch/queue normalization
- Historical bulk backfill tooling
- Provider-specific email dot or plus-tag rules
- Address parsing, geocoding, or deliverability verification
