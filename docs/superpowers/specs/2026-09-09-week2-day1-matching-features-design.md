# Week 2 Day 1 Matching Features Design

## Status and goal

Approved in chat on 2026-09-09. Build deterministic field comparators and a
versioned feature extractor for normalized Person and Company records.

This milestone produces comparison evidence only. It does not calculate a
confidence score, choose `AUTO_MATCH`, `REVIEW`, or `NO_MATCH`, create or update
entities, persist evidence, or change an HTTP endpoint. Later Week 2 milestones
will consume this package.

## Package boundary

Add a pure `@resolve/matching` workspace package under `packages/matching`.
The package contains no NestJS, Prisma, Redis, or network code. It depends on
`@resolve/contracts` for `ContradictionEvidence` and on
`@resolve/normalization` for normalized record types and conservative text
preparation.

The API and worker can call the package without duplicating comparison logic.
Unit tests can exercise every algorithm without starting infrastructure.

The package exports:

- scalar exact, edit, Jaro-Winkler, token, and domain comparators;
- structured address comparison;
- Person and Company feature types;
- the feature extraction entry point;
- `FEATURE_VERSION = "features-v1"`.

Root build and typecheck scripts must compile the package before the API and
worker. Docker dependency and runtime stages must include the workspace
manifest and compiled output so later API integration cannot repeat the
missing-workspace failure fixed at the Week 1 checkpoint.

## Comparison input and result

The feature extractor accepts two records with the same entity type:

```ts
interface ComparisonRecord {
  entityType: 'person' | 'company';
  normalizedPayload: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
}
```

`normalizedPayload` supplies names, email, phone, domain, company, and address
values produced by `normalization-v1`. `rawPayload` supplies the Company
`registration_id`, which Day 5 preserves as source truth but does not store in
the normalized payload.

The extractor rejects mixed entity types with a domain-specific
`EntityTypeMismatchError`. Day 6 blocking already filters by type, but the
matching boundary enforces the invariant as a second defense.

The result uses explicit entity-specific feature interfaces:

```ts
interface FeatureExtractionResult<TFeatures> {
  featureVersion: 'features-v1';
  entityType: 'person' | 'company';
  features: TFeatures;
  contradictions: ContradictionEvidence[];
}
```

Feature keys use snake case because `ResolutionExplanation.features` exposes
them through the public API later. The extractor returns features in a stable
object shape, including `null` values.

## Missing-value policy

Comparators treat `null`, `undefined`, empty strings, and whitespace-only
strings as missing. A comparator returns `null` when either input is missing.
This distinguishes absent evidence from disagreement.

For two present values:

- exact comparators return `true` for equality and `false` for inequality;
- similarity comparators return a number from 0 through 1;
- an exact string match returns similarity 1.

The feature extractor reads only the expected normalized fields. Malformed
objects and unexpected value types become missing evidence instead of causing
unsafe coercion.

## Scalar algorithms

### Exact equality

`exactEquality` compares two present strings without changing case or
punctuation. Normalization owns those transformations. This keeps email local
parts case-sensitive under `normalization-v1`.

### Edit similarity

`editSimilarity` calculates Levenshtein distance over Unicode code points and
converts it to similarity:

```text
1 - distance / max(leftLength, rightLength)
```

The implementation uses two rows of the distance matrix, limiting memory to
the shorter input length. The function clamps its result to the inclusive
0-to-1 range.

### Jaro-Winkler name similarity

`jaroWinklerSimilarity` implements standard Jaro matching with the Winkler
prefix adjustment:

- match window: `floor(maxLength / 2) - 1`, with a minimum of zero;
- prefix length capped at four Unicode code points;
- prefix scale `0.1`;
- Winkler adjustment applied when the Jaro score is at least `0.7`.

The result remains symmetric and bounded. Tests use published reference pairs
such as `martha`/`marhta` and `dixon`/`dicksonx` with numeric tolerances.

### Token similarity

`tokenSimilarity` splits normalized text on Unicode whitespace, removes empty
tokens, deduplicates each token set, and returns Jaccard similarity:

```text
intersectionSize / unionSize
```

Token order and duplicates do not affect the score. Punctuation remains part
of a token because normalization-v1 preserves internal punctuation.

### Domain comparison

`domainEquality` delegates to exact equality on normalized ASCII domain
values. It performs no suffix, subdomain, registrable-domain, or edit matching.
A shared domain can become positive evidence, while later scoring policy
controls its weight.

## Address comparison

Address token similarity flattens present `line1`, `line2`, `city`, `region`,
`postal_code`, and `country` fields in that order, then applies token Jaccard
similarity. It also exposes exact country equality as a separate feature.

The extractor does not infer countries, geocode addresses, expand
abbreviations, or merge address fields. Two missing addresses produce missing
evidence.

## Person features

Person extraction returns these stable fields:

```text
email_exact
phone_exact
name_edit_similarity
name_jaro_winkler_similarity
company_name_token_similarity
company_domain_exact
address_token_similarity
country_exact
```

Person name algorithms compare normalized `name` values. Company token
similarity compares the `base` value from normalized company-name objects, so
legal suffix changes do not reduce the token score. Company domain comparison
uses `company_domain`.

## Company features

Company extraction returns these stable fields:

```text
email_exact
phone_exact
company_name_edit_similarity
company_name_jaro_winkler_similarity
company_name_token_similarity
domain_exact
address_token_similarity
country_exact
registration_id_exact
```

Company name algorithms compare normalized company `base` values. Domain
comparison uses normalized `domain` values.

Registration IDs receive comparison-time preparation because
normalization-v1 leaves them in raw source truth. The preparation applies
Unicode NFKC, trims outer whitespace, collapses Unicode whitespace, and uses
locale-independent lowercase. It preserves punctuation and internal token
structure. The extractor does not persist this derived value.

## Contradiction evidence

The extractor emits a contradiction only when both comparable values are
present and unequal. It uses stable codes and avoids embedding raw values in
messages.

Warning contradictions:

```text
EMAIL_CONFLICT
PHONE_CONFLICT
COMPANY_DOMAIN_CONFLICT
COUNTRY_CONFLICT
```

`COMPANY_DOMAIN_CONFLICT` covers Person company domains and Company domains.
Email, phone, domain, and country can change or be shared, so Day 1 classifies
them as warnings. Later scoring and decision policy can combine multiple
warnings into stronger negative evidence.

One contradiction blocks automatic matching:

```text
REGISTRATION_ID_CONFLICT
```

A mismatch between two present Company registration IDs represents a
conflicting trusted legal identifier. The contradiction uses severity
`blocking`. A matching registration ID supplies positive exact evidence but
does not remove unrelated contradictions.

Contradictions appear in a fixed field order. This gives stored explanations
and tests deterministic output.

## Error handling

Pure scalar comparators do not throw for missing input. The feature extractor
throws only for programmer-contract violations such as different entity
types. It narrows unknown normalized payload values and treats malformed field
shapes as missing.

No comparator logs record values or other PII.

## Testing

Jest unit tests cover:

- exact matches, mismatches, null, undefined, empty, and whitespace values;
- Unicode code-point edit distance, symmetry, identity, and range bounds;
- Jaro-Winkler reference pairs, transpositions, prefixes, symmetry, and bounds;
- token order, duplicate tokens, disjoint sets, Unicode tokens, and punctuation;
- exact domain comparison with missing values;
- address flattening and country comparison;
- complete and sparse Person feature extraction;
- complete and sparse Company feature extraction;
- warning contradiction ordering;
- blocking registration-ID conflicts;
- matching registration IDs after conservative preparation;
- entity-type mismatch rejection;
- malformed normalized payload fields;
- representative evidence from the version-controlled golden dataset.

The Day 1 golden-data tests assert feature and contradiction evidence. They do
not assert final decisions because scoring and decision policy do not exist in
this milestone. The existing Ethiopian national-phone case must add
`address.country = "ET"` to the national-format record so it satisfies the
country-context rule already locked by `normalization-v1`; its label,
expected decision, and rationale remain unchanged.

No database migration or integration test is required for pure comparison
logic. The existing integration suites must remain green.

Before review, run:

```text
npm run prisma:validate
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
docker compose build api worker
docker compose config --quiet
```

## Documentation and housekeeping

Update the architecture document with the `@resolve/matching` boundary,
`features-v1`, and the separation between evidence extraction and scoring.
Update the README milestone section. Swagger stays unchanged because Day 1
adds no endpoint.

Run Prettier on the four Day 7 files identified during the Week 1 Docker fix:

```text
docs/architecture/overview.md
README.md
tests/fixtures/day7-integration-records.json
tests/integration/day7-checkpoint.integration.ts
```

Keep those edits mechanical and separate from matching behavior during review
and later commits.

## Acceptance criteria

Day 1 is ready for review when:

- the matching package exports all required deterministic comparators;
- every similarity score stays between 0 and 1;
- missing values remain distinct from mismatches;
- Person and Company extraction returns stable typed feature shapes;
- the extractor records warning and blocking contradictions with stable codes;
- registration-ID conflicts cannot disappear behind positive similarity;
- tests cover Unicode, null, empty, malformed, and golden-data cases;
- no scoring, decision, persistence, or HTTP behavior changes;
- documentation and all verification commands pass.
