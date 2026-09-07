-- AlterTable
ALTER TABLE "source_records"
ADD COLUMN "current_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "raw_payload_hash" CHAR(64);

ALTER TABLE "source_records"
ADD CONSTRAINT "source_records_current_version_positive" CHECK ("current_version" > 0),
ADD CONSTRAINT "source_records_raw_payload_hash_format"
CHECK ("raw_payload_hash" IS NULL OR "raw_payload_hash" ~ '^[0-9a-f]{64}$');

-- CreateTable
CREATE TABLE "source_record_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "source_record_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "source_record_versions_version_positive" CHECK ("version" > 0),
    CONSTRAINT "source_record_versions_payload_hash_format" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$')
);

-- CreateTable
CREATE TABLE "idempotency_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "operation" VARCHAR(100) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "idempotency_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "idempotency_requests_request_hash_format" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "idempotency_requests_response_status_range" CHECK ("response_status" BETWEEN 200 AND 599)
);

-- CreateIndex
CREATE UNIQUE INDEX "source_record_versions_tenant_record_version_key"
ON "source_record_versions"("tenant_id", "source_record_id", "version");

CREATE UNIQUE INDEX "idempotency_requests_tenant_key_key"
ON "idempotency_requests"("tenant_id", "key");

CREATE INDEX "idempotency_requests_tenant_created_idx"
ON "idempotency_requests"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "source_record_versions" ADD CONSTRAINT "source_record_versions_tenant_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "source_record_versions" ADD CONSTRAINT "source_record_versions_tenant_source_record_fkey"
FOREIGN KEY ("tenant_id", "source_record_id") REFERENCES "source_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "idempotency_requests" ADD CONSTRAINT "idempotency_requests_tenant_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;