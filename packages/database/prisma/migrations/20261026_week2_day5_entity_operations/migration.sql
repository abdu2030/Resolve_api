CREATE TYPE "entity_status" AS ENUM ('ACTIVE', 'MERGED');
CREATE TYPE "entity_operation_type" AS ENUM ('MERGE', 'SPLIT', 'UNMERGE');
ALTER TYPE "canonical_trigger_operation" ADD VALUE 'MERGE';
ALTER TYPE "canonical_trigger_operation" ADD VALUE 'SPLIT';

ALTER TABLE "api_keys"
ADD CONSTRAINT "api_keys_tenant_id_key" UNIQUE ("tenant_id", "id");

ALTER TABLE "entities"
ADD COLUMN "status" "entity_status" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "merged_into_entity_id" UUID,
ADD CONSTRAINT "entities_lifecycle_consistency" CHECK (
    ("status" = 'ACTIVE' AND "merged_into_entity_id" IS NULL)
    OR ("status" = 'MERGED' AND "merged_into_entity_id" IS NOT NULL AND "merged_into_entity_id" <> "id")
),
ADD CONSTRAINT "entities_tenant_merged_into_fkey"
FOREIGN KEY ("tenant_id", "merged_into_entity_id") REFERENCES "entities"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE "entity_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "type" "entity_operation_type" NOT NULL,
    "operation_version" VARCHAR(50) NOT NULL DEFAULT 'entity-operations-v1',
    "source_entity_id" UUID NOT NULL,
    "target_entity_id" UUID NOT NULL,
    "record_ids" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "actor_api_key_id" UUID NOT NULL,
    "source_version_before" INTEGER NOT NULL,
    "source_version_after" INTEGER NOT NULL,
    "target_version_before" INTEGER NOT NULL,
    "target_version_after" INTEGER NOT NULL,
    "reversed_operation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entity_operations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "entity_operations_tenant_id_key" UNIQUE ("tenant_id", "id"),
    CONSTRAINT "entity_operations_tenant_reversed_operation_key" UNIQUE ("tenant_id", "reversed_operation_id"),
    CONSTRAINT "entity_operations_distinct_entities" CHECK ("source_entity_id" <> "target_entity_id"),
    CONSTRAINT "entity_operations_record_ids_count" CHECK (
        CASE WHEN jsonb_typeof("record_ids") = 'array' THEN jsonb_array_length("record_ids") BETWEEN 1 AND 1000 ELSE FALSE END
    ),
    CONSTRAINT "entity_operations_versions_nonnegative" CHECK (
        "source_version_before" >= 0 AND "source_version_after" >= 0 AND "target_version_before" >= 0 AND "target_version_after" >= 0
    ),
    CONSTRAINT "entity_operations_reversal_consistency" CHECK (
        ("type" = 'UNMERGE') = ("reversed_operation_id" IS NOT NULL)
    ),
    CONSTRAINT "entity_operations_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "entity_operations_tenant_source_fkey" FOREIGN KEY ("tenant_id", "source_entity_id") REFERENCES "entities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "entity_operations_tenant_target_fkey" FOREIGN KEY ("tenant_id", "target_entity_id") REFERENCES "entities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "entity_operations_tenant_actor_fkey" FOREIGN KEY ("tenant_id", "actor_api_key_id") REFERENCES "api_keys"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "entity_operations_tenant_reversed_operation_fkey" FOREIGN KEY ("tenant_id", "reversed_operation_id") REFERENCES "entity_operations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

ALTER TABLE "entity_record_links"
ADD COLUMN "last_entity_operation_id" UUID,
ADD CONSTRAINT "entity_record_links_tenant_last_operation_fkey"
FOREIGN KEY ("tenant_id", "last_entity_operation_id") REFERENCES "entity_operations"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "entity_canonical_versions"
ADD COLUMN "entity_operation_id" UUID,
ADD CONSTRAINT "entity_canonical_versions_tenant_operation_fkey"
FOREIGN KEY ("tenant_id", "entity_operation_id") REFERENCES "entity_operations"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Reversals are separate events. Historical operation evidence is never rewritten.
CREATE FUNCTION "reject_entity_operation_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Entity operation audit events are append-only'
        USING ERRCODE = '23514', CONSTRAINT = 'entity_operations_append_only';
END;
$$;

CREATE TRIGGER "entity_operations_append_only"
BEFORE UPDATE OR DELETE ON "entity_operations"
FOR EACH ROW EXECUTE FUNCTION "reject_entity_operation_mutation"();
