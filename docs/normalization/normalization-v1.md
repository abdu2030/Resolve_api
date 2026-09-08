# Normalization Policy: normalization-v1

Resolve preserves submitted source data and stores normalized values separately
as deterministic derived evidence. Normalization never mutates
`source_records.raw_payload` or `source_record_versions.raw_payload`.

## Shared text preparation

String normalizers apply Unicode NFKC, trim outer whitespace, and collapse
consecutive Unicode whitespace to one ASCII space. Empty, whitespace-only,
null, undefined, and non-string values produce `null`.

Names and address text components are lowercased with locale-independent
Unicode casing. Accents, non-Latin scripts, apostrophes, hyphens, and other
internal punctuation remain present.

## Email

Email local parts preserve case, dots, plus-tags, and all other accepted
characters. The accepted local-part alphabet is the conservative ASCII
dot-atom set. Only the domain is normalized and lowercased. Local parts that
are empty, longer than 64 characters, contain unsupported characters, start or
end with a dot, or contain consecutive dots are rejected. The normalized email
cannot exceed 320 characters.

Provider-specific dot removal and plus-tag removal are not part of
`normalization-v1`.

## Phone

Valid phones are returned in E.164 format through `libphonenumber-js`.
International `+` numbers do not require country context. National-format
numbers require a supported two-letter country code from the record address.
Resolve never guesses a default country. Missing context, parse errors, and
invalid phone numbers produce `null`.

## Company

Company names preserve the full normalized name while exposing a separate base
name and legal-suffix signal. Only a final, optionally period-terminated token
is considered.

The recognized suffixes are:

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

If suffix removal would leave an empty base, no suffix is extracted.

## Domain

Domains may be bare hostnames or HTTP/HTTPS URLs with an empty path. Resolve
lowercases the host, converts internationalized hosts to ASCII, removes exactly
one leading `www.`, and removes trailing root dots.

Credentials, ports, paths, queries, fragments, non-HTTP schemes, IP addresses,
`localhost`, single-label hosts, wildcards, empty labels, and invalid DNS
labels produce `null`.

## Address

Address normalization keeps `line1`, `line2`, `city`, `region`,
`postal_code`, and `country` separate. Text components use name rules,
postal codes are uppercased after shared text preparation, and countries must
be exactly two ASCII letters and are uppercased. Unknown properties are
ignored. An address with no usable recognized component becomes `null`.

## Record payloads and projections

Person normalized payloads contain fixed `name`, `email`, `phone`,
`company`, `company_domain`, and `address` keys. Company payloads contain
fixed `name`, `domain`, `email`, `phone`, and `address` keys. Missing or
invalid values are `null`.

Opaque `attributes` and company `registration_id` remain only in raw source
truth for Day 5.

Each source record stores:

- `normalization_version = normalization-v1`
- the fixed normalized payload
- normalized email and phone projections
- the Person company domain or Company domain projection
- the first 64 Unicode code points of the normalized name

An unchanged record already on `normalization-v1` performs no write. An
unchanged record with missing or older normalization refreshes only derived
fields; it does not increment the raw version or add a history row.

Any semantic rule change requires a new normalization version and updated
tests.
