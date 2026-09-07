-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "entity_type" AS ENUM ('PERSON', 'COMPANY');

-- CreateEnum
CREATE TYPE "match_decision" AS ENUM ('AUTO_MATCH', 'REVIEW', 'NO_MATCH');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'ACTIVE',
    "plan" VARCHAR(50) NOT NULL DEFAULT 'free',
    "plan_metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "prefix" VARCHAR(32) NOT NULL,
    "key_hash" VARCHAR(255) NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_systems" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_systems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "source_system_id" UUID NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "entity_type" "entity_type" NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "normalized_payload" JSONB,
    "normalization_version" VARCHAR(50),
    "normalized_email" VARCHAR(320),
    "normalized_phone" VARCHAR(32),
    "company_domain" VARCHAR(253),
    "normalized_name_prefix" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "entity_type" "entity_type" NOT NULL,
    "canonical_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_record_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "score" DECIMAL(5,4) NOT NULL,
    "decision" "match_decision" NOT NULL,
    "algorithm_version" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_record_links_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "entity_record_links"
ADD CONSTRAINT "entity_record_links_score_range"
CHECK ("score" >= 0 AND "score" <= 1);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_tenant_revoked_idx" ON "api_keys"("tenant_id", "revoked_at");

-- CreateIndex
CREATE INDEX "api_keys_prefix_idx" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "source_systems_tenant_name_key" ON "source_systems"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "source_systems_tenant_id_key" ON "source_systems"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "source_records_tenant_normalized_email_idx" ON "source_records"("tenant_id", "normalized_email");

-- CreateIndex
CREATE INDEX "source_records_tenant_normalized_phone_idx" ON "source_records"("tenant_id", "normalized_phone");

-- CreateIndex
CREATE INDEX "source_records_tenant_company_domain_idx" ON "source_records"("tenant_id", "company_domain");

-- CreateIndex
CREATE INDEX "source_records_tenant_type_name_prefix_idx" ON "source_records"("tenant_id", "entity_type", "normalized_name_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "source_records_tenant_id_key" ON "source_records"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "source_records_tenant_source_external_key" ON "source_records"("tenant_id", "source_system_id", "external_id");

-- CreateIndex
CREATE INDEX "entities_tenant_entity_type_idx" ON "entities"("tenant_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "entities_tenant_id_key" ON "entities"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "entity_record_links_tenant_entity_idx" ON "entity_record_links"("tenant_id", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_record_links_tenant_record_key" ON "entity_record_links"("tenant_id", "source_record_id");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "source_systems" ADD CONSTRAINT "source_systems_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_tenant_source_system_fkey" FOREIGN KEY ("tenant_id", "source_system_id") REFERENCES "source_systems"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "entity_record_links" ADD CONSTRAINT "entity_record_links_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "entity_record_links" ADD CONSTRAINT "entity_record_links_tenant_entity_fkey" FOREIGN KEY ("tenant_id", "entity_id") REFERENCES "entities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "entity_record_links" ADD CONSTRAINT "entity_record_links_tenant_source_record_fkey" FOREIGN KEY ("tenant_id", "source_record_id") REFERENCES "source_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
