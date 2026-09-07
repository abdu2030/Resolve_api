# Day 4 API-Key Authentication and Record Ingestion Design

## Goal

Add tenant-scoped API-key authentication, scope authorization, source registration, and versioned single-record ingestion. Repeated and concurrent requests must not create duplicate source records or raw versions.

## Scope

Day 4 adds:

- API-key generation, hashing, authentication, revocation checks, and last-used tracking.
- Tenant derivation from authenticated credentials.
- Scope checks for `sources:write` and `records:write`.
- `POST /v1/sources`.
- `POST /v1/records`.
- Immutable raw source-record versions.
- Natural idempotency through `(tenant_id, source_system_id, external_id)`.
- Optional `Idempotency-Key` replay protection.
- A local operator command that creates a tenant and its first API key.
- Unit, HTTP integration, migration, concurrency, security, and OpenAPI tests.

Day 4 does not normalize fields, generate candidates, score matches, create canonical entities, or return resolution decisions.

## Architecture

The NestJS API gains focused `auth`, `sources`, `records`, and `common/http` modules. Controllers validate HTTP input and call application services. Services own transactions and domain decisions. Prisma remains the only database access layer.

The request path is:

```text
HTTP request
  -> capture original JSON bytes
  -> authenticate API key
  -> derive tenant and scopes
  -> validate DTO
  -> authorize required scope
  -> application service
  -> tenant-scoped Prisma transaction
  -> consistent HTTP response
```

The API installs authentication and scope guards globally. The health endpoint stays public through an explicit `@Public()` marker. Swagger UI and its JSON document remain public development surfaces.

## API-Key Format and Storage

Generated keys use this structure:

```text
rslv_test_<12 lowercase hexadecimal characters>.<43 base64url characters>
rslv_live_<12 lowercase hexadecimal characters>.<43 base64url characters>
```

The 43-character secret comes from 32 cryptographically random bytes. The database stores:

- The non-secret prefix through the period delimiter.
- A SHA-256 hash of the complete plaintext key.
- Tenant ownership.
- Explicit scopes.
- Creation, revocation, and last-used timestamps.

SHA-256 is suitable because the service generates a 256-bit random secret rather than accepting a human password. The service never stores or logs the plaintext key. An operator sees it once when the bootstrap command creates it.

## Local Credential Bootstrap

The repository adds an operator command:

```powershell
npm run auth:bootstrap -- --tenant-name "Local Demo" --environment test
```

The command creates one tenant and one API key. Its default scopes are `sources:write` and `records:write`. Optional arguments can set the key label and a comma-separated scope list. The command prints a JSON result containing the tenant ID, key ID, scopes, and plaintext API key. It does not write the plaintext key to a file.

Day 4 does not add an unauthenticated tenant or API-key management endpoint. HTTP key issuance, rotation, and revocation workflows require a separate administrative authentication design.

## Authentication and Tenant Derivation

Clients send:

```http
Authorization: Bearer rslv_test_<identifier>.<secret>
```

The authentication guard:

1. Requires one Bearer token with the expected key format.
2. Hashes the complete token with SHA-256.
3. Loads the key and tenant by `key_hash`.
4. Rejects missing, malformed, unknown, or revoked keys with HTTP 401.
5. Rejects keys for non-active tenants with HTTP 401.
6. Updates `last_used_at` after successful authentication.
7. Attaches an immutable principal containing `tenantId`, `apiKeyId`, and scopes to the request.

Every protected query receives `tenantId` from this principal. Controllers and DTOs expose no tenant ID field.

## Scope Authorization

Day 4 defines these scopes:

```text
sources:write
records:write
```

`POST /v1/sources` requires `sources:write`. `POST /v1/records` requires `records:write`. An authenticated key without the required scope receives HTTP 403. Scope checks use route metadata and a dedicated guard so future endpoints can reuse the same mechanism.

## Raw Request Preservation

The existing validation DTO transforms selected values, including uppercasing an address country code. The service must preserve the submitted values before those transformations.

The Express JSON parser captures the original request bytes. After the global validation pipe accepts the DTO, the records controller reads the original JSON object and passes its `data` member to the ingestion service. PostgreSQL stores that object as JSONB. This preserves submitted string casing, spacing, nulls, and nested values, while JSONB may reorder object keys and does not preserve insignificant JSON whitespace.

The service does not store malformed or rejected request bodies.

## Source Registration

### Request

```http
POST /v1/sources
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "name": "crm",
  "type": "api"
}
```

`name` and `type` must be lowercase identifiers containing letters, numbers, hyphens, or underscores. `name` may contain at most 120 characters and `type` at most 50 characters.

### Behavior

- A new tenant-local source returns HTTP 201.
- Re-registering the same name and type returns the existing source with HTTP 200.
- Reusing the same tenant-local name with another type returns HTTP 409.
- Another tenant may use the same name.
- The transaction handles simultaneous attempts through the existing tenant/name uniqueness constraint.

### Response

```json
{
  "source_id": "uuid",
  "name": "crm",
  "type": "api",
  "created_at": "2026-09-07T10:00:00.000Z"
}
```

## Record Ingestion Contract

The endpoint accepts the locked MVP record envelope:

```http
POST /v1/records
Authorization: Bearer <api-key>
Idempotency-Key: optional-client-key
Content-Type: application/json

{
  "source": "crm",
  "external_id": "contact_9234",
  "entity_type": "person",
  "data": {
    "name": "Abdulkerim Hassen",
    "email": "abdul@example.com",
    "phone": "0911223344"
  }
}
```

The DTO validates `person` and `company` data through their locked nested DTOs. Unknown root and nested fields fail. The source must exist inside the authenticated tenant. A source from another tenant appears missing and returns HTTP 404.

### Response

```json
{
  "record_id": "uuid",
  "source_id": "uuid",
  "external_id": "contact_9234",
  "entity_type": "person",
  "version": 1,
  "status": "STORED",
  "operation": "CREATED",
  "created_at": "2026-09-07T10:00:00.000Z",
  "updated_at": "2026-09-07T10:00:00.000Z"
}
```

`operation` is `CREATED`, `UPDATED`, or `UNCHANGED`:

- `CREATED` returns HTTP 201 for the first observation.
- `UPDATED` returns HTTP 200 when changed raw data creates a new version.
- `UNCHANGED` returns HTTP 200 when the current raw data already matches.

Matching fields such as `entity_id`, `decision`, `confidence`, `explanation`, and `algorithm_version` remain absent until the matching pipeline exists.

## Versioned Upsert Rules

The stable source record identity remains:

```text
(tenant_id, source_system_id, external_id)
```

The ingestion transaction follows these rules:

1. Lock the tenant-local source-record identity for the transaction.
2. Create the stable source record and raw version 1 when no record exists.
3. Compare a canonical SHA-256 hash of the incoming raw `data` object with the current raw payload hash.
4. Return `UNCHANGED` without a write when the hashes match.
5. Reject an attempt to change the stable record's entity type with HTTP 409.
6. Insert the next immutable raw version before advancing the stable source record when the payload changed.
7. Update the stable record's current raw payload, current version number, payload hash, and timestamp.
8. Clear derived normalization fields when raw data changes so stale normalized values cannot survive a later Day 5 update.

Canonical JSON hashing sorts object keys recursively. Array order and string content remain significant. Requests whose objects differ only by property order produce the same hash.

PostgreSQL transaction-scoped advisory locks serialize requests for the same tenant, source, and external ID. Database uniqueness constraints remain the final integrity boundary.

## Persistence Changes

### source_records additions

```text
current_version   integer, required, default 1
raw_payload_hash  char(64), nullable only for rows created before this migration
```

The service initializes version history and the missing hash before changing a legacy row.

### source_record_versions

```text
id                uuid primary key
tenant_id         uuid, required
source_record_id  uuid, required
version           integer, required and greater than zero
raw_payload       jsonb, required
payload_hash      char(64), required
created_at        timestamptz(3), required
```

The table has a tenant-safe composite foreign key to `source_records`, a unique key on `(tenant_id, source_record_id, version)`, and an index for ordered version retrieval. Application code never updates or deletes a version row.

### idempotency_requests

```text
id               uuid primary key
tenant_id        uuid, required
key              varchar(255), required
operation        varchar(80), required
request_hash     char(64), required
response_status  smallint, required
response_body    jsonb, required
created_at       timestamptz(3), required
```

The table has a tenant foreign key, a unique key on `(tenant_id, key)`, and a tenant/created-at index. It stores identifiers and response metadata, not raw source data or API-key secrets.

## Idempotency-Key Rules

The `Idempotency-Key` header is optional for record ingestion. It must contain 1 through 255 visible ASCII characters and cannot contain whitespace.

When a key is present:

1. The service hashes the canonical validated request envelope.
2. The transaction locks the tenant/key pair.
3. An existing row with the same operation and request hash returns its stored status and body.
4. An existing row with different content or operation returns HTTP 409 with `IDEMPOTENCY_KEY_REUSED`.
5. A new successful response is stored in the same transaction as the record and version writes.

A replay returns the original status and body and adds this response header:

```http
Idempotency-Replayed: true
```

A failed transaction does not leave an idempotency row. Clients can retry transient failures safely.

## Error Model

Day 4 standardizes API errors:

```json
{
  "error": {
    "code": "SOURCE_NOT_FOUND",
    "message": "Source system was not found."
  }
}
```

Validation failures include a `details` array of safe validation messages. The API does not return stack traces, SQL errors, hashes, API-key prefixes, tenant IDs from other tenants, or submitted PII.

Day 4 uses these status mappings:

- 400: malformed JSON, invalid header, or DTO validation failure.
- 401: missing, invalid, revoked, or inactive-tenant API key.
- 403: missing scope.
- 404: source does not exist for the authenticated tenant.
- 409: source type conflict, entity-type conflict, or idempotency-key reuse.
- 500: safe generic response for an unexpected server error.
- 503: database or other transient dependency failure.

## Transactions and Concurrency

Source registration and record ingestion use transactions. Record ingestion keeps the idempotency row, stable source record, raw version, and current-record update in one atomic unit.

The service acquires locks in this order to avoid deadlocks:

1. Tenant/idempotency key when the header exists.
2. Tenant/source/external record identity.

Concurrency tests submit simultaneous identical record requests and require one stable record and one raw version. A changed-payload test requires sequential versions without gaps.

## Logging and Sensitive Data

Authentication and ingestion code does not log complete API keys, authorization headers, raw payloads, emails, phone numbers, or names. Errors expose stable codes and general messages. Database identifiers may appear only where the authenticated client is authorized to receive them.

## OpenAPI

Swagger documents:

- Bearer API-key authentication.
- Required scopes in endpoint descriptions.
- Source and record request schemas.
- Created, replay, validation, authentication, authorization, not-found, and conflict responses.
- Optional `Idempotency-Key` and replay response headers.

The health endpoint remains outside `/v1`. Sources and records remain under `/v1`.

## Testing

### Unit and contract tests

- API-key format, random generation, prefix extraction, and deterministic hashing.
- Bearer-header parsing without leaking token values.
- Principal and scope metadata behavior.
- Conditional Person and Company record-envelope validation.
- Canonical JSON hashing, including property-order equivalence.
- Domain error to HTTP error mapping.

### PostgreSQL and HTTP integration tests

- Missing, malformed, unknown, revoked, and inactive-tenant keys return 401.
- A valid key authenticates and updates `last_used_at`.
- A key without a required scope returns 403.
- Two tenants cannot access each other's sources.
- Source creation, identical registration, conflicting registration, and concurrent registration behave as specified.
- Ingestion stores the original raw values rather than transformed DTO values.
- Identical ingestion returns one record and one raw version.
- Changed data retains version 1 and creates version 2.
- Entity-type changes return 409 without changing stored data.
- The same idempotency key and request replay the stored response.
- The same idempotency key with another request returns 409.
- Concurrent retries create no duplicate record, version, or idempotency row.
- Invalid root fields, nested fields, and entity-specific data return 400.

### Repository verification

- Prisma validates and deploys the new migration to an empty schema twice.
- Unit, integration, concurrency, OpenAPI, lint, format, type-check, and build checks pass.
- The Docker stack starts against the migrated database.
- The README documents bootstrap, authentication, source registration, ingestion, replay, inspection, and cleanup commands.

## Acceptance Criteria

- An operator can create a tenant and receive one plaintext API key through the bootstrap command.
- Protected endpoints derive the tenant only from a valid active API key.
- Scope checks deny unauthorized operations.
- A tenant can register and reuse its own source name without crossing tenant boundaries.
- `POST /v1/records` stores validated raw Person and Company payloads.
- A stable source record retains every changed raw observation as an immutable ordered version.
- Identical and concurrent retries do not create duplicate records or versions.
- Reused idempotency keys replay the original response or fail safely when content differs.
- Day 4 introduces no normalization or matching behavior.
- All changes remain uncommitted until the user reviews the completed implementation.
