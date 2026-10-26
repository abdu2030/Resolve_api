CREATE TYPE "canonical_selection_rule" AS ENUM (
    'ONLY_CANDIDATE',
    'SOURCE_PRIORITY',
    'COMPLETENESS',
    'RECENCY',
    'STABLE_TIE_BREAK'
);

CREATE TYPE "canonical_trigger_operation" AS ENUM (
    'ENTITY_CREATED',
    'RECORD_LINKED',
    'RECORD_UPDATED',
    'LEGACY_BACKFILL'
);

ALTER TABLE "source_systems"
ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100,
ADD CONSTRAINT "source_systems_priority_range"
CHECK ("priority" BETWEEN 0 AND 1000);

ALTER TABLE "entities"
ADD COLUMN "canonical_version" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "entities_canonical_version_nonnegative"
CHECK ("canonical_version" >= 0);

CREATE TABLE "entity_field_provenance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "field_path" VARCHAR(100) NOT NULL,
    "canonical_value" JSONB NOT NULL,
    "raw_value" JSONB NOT NULL,
    "source_record_id" UUID NOT NULL,
    "source_system_id" UUID NOT NULL,
    "source_external_id" VARCHAR(255) NOT NULL,
    "source_priority" INTEGER NOT NULL,
    "selection_rule" "canonical_selection_rule" NOT NULL,
    "completeness_score" INTEGER NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "normalization_version" VARCHAR(50) NOT NULL,
    "canonicalization_version" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_field_provenance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "entity_field_provenance_tenant_entity_field_key"
        UNIQUE ("tenant_id", "entity_id", "field_path")
);

CREATE TABLE "entity_canonical_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "canonical_data" JSONB NOT NULL,
    "provenance" JSONB NOT NULL,
    "trigger_source_record_id" UUID,
    "trigger_operation" "canonical_trigger_operation" NOT NULL,
    "canonicalization_version" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_canonical_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "entity_canonical_versions_tenant_entity_version_key"
        UNIQUE ("tenant_id", "entity_id", "version")
);

CREATE INDEX "entity_field_provenance_tenant_entity_idx"
ON "entity_field_provenance"("tenant_id", "entity_id");

CREATE INDEX "entity_canonical_versions_tenant_entity_version_idx"
ON "entity_canonical_versions"("tenant_id", "entity_id", "version" DESC);

ALTER TABLE "entity_field_provenance"
ADD CONSTRAINT "entity_field_provenance_tenant_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "entity_field_provenance"
ADD CONSTRAINT "entity_field_provenance_tenant_entity_fkey"
FOREIGN KEY ("tenant_id", "entity_id") REFERENCES "entities"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "entity_field_provenance"
ADD CONSTRAINT "entity_field_provenance_tenant_source_record_fkey"
FOREIGN KEY ("tenant_id", "source_record_id") REFERENCES "source_records"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "entity_field_provenance"
ADD CONSTRAINT "entity_field_provenance_tenant_source_system_fkey"
FOREIGN KEY ("tenant_id", "source_system_id") REFERENCES "source_systems"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "entity_canonical_versions"
ADD CONSTRAINT "entity_canonical_versions_tenant_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "entity_canonical_versions"
ADD CONSTRAINT "entity_canonical_versions_tenant_entity_fkey"
FOREIGN KEY ("tenant_id", "entity_id") REFERENCES "entities"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "entity_canonical_versions"
ADD CONSTRAINT "entity_canonical_versions_tenant_trigger_record_fkey"
FOREIGN KEY ("tenant_id", "trigger_source_record_id") REFERENCES "source_records"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;
