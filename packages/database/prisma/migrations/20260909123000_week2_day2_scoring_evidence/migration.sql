CREATE TABLE "match_features" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "candidate_source_record_id" UUID NOT NULL,
    "candidate_entity_id" UUID NOT NULL,
    "feature_version" VARCHAR(50) NOT NULL,
    "algorithm_version" VARCHAR(50) NOT NULL,
    "score_inputs" JSONB NOT NULL,
    "explanation" JSONB NOT NULL,
    "score" DECIMAL(5,4) NOT NULL,
    "decision" "match_decision" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_features_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "match_features_tenant_source_record_idx"
ON "match_features"("tenant_id", "source_record_id");

CREATE INDEX "match_features_tenant_candidate_entity_idx"
ON "match_features"("tenant_id", "candidate_entity_id");

CREATE INDEX "match_features_tenant_candidate_record_idx"
ON "match_features"("tenant_id", "candidate_source_record_id");

ALTER TABLE "match_features"
ADD CONSTRAINT "match_features_score_range"
CHECK ("score" >= 0 AND "score" <= 1);

ALTER TABLE "match_features"
ADD CONSTRAINT "match_features_tenant_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "match_features"
ADD CONSTRAINT "match_features_tenant_source_record_fkey"
FOREIGN KEY ("tenant_id", "source_record_id")
REFERENCES "source_records"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "match_features"
ADD CONSTRAINT "match_features_tenant_candidate_entity_fkey"
FOREIGN KEY ("tenant_id", "candidate_entity_id")
REFERENCES "entities"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "match_features"
ADD CONSTRAINT "match_features_tenant_candidate_record_fkey"
FOREIGN KEY ("tenant_id", "candidate_source_record_id")
REFERENCES "source_records"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;
