CREATE TYPE "review_case_status" AS ENUM ('OPEN', 'RESOLVED');

ALTER TABLE "entity_record_links"
ADD COLUMN "explanation" JSONB NOT NULL
DEFAULT '{"candidate_count":0,"features":{},"contradictions":[]}'::jsonb;

ALTER TABLE "match_features"
ADD CONSTRAINT "match_features_review_identity_key"
UNIQUE (
    "tenant_id",
    "id",
    "source_record_id",
    "candidate_source_record_id",
    "candidate_entity_id"
);

CREATE TABLE "review_cases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "candidate_entity_id" UUID NOT NULL,
    "candidate_source_record_id" UUID NOT NULL,
    "match_feature_id" UUID NOT NULL,
    "status" "review_case_status" NOT NULL DEFAULT 'OPEN',
    "score" DECIMAL(5,4) NOT NULL,
    "explanation" JSONB NOT NULL,
    "algorithm_version" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_cases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_cases_tenant_source_record_key"
        UNIQUE ("tenant_id", "source_record_id"),
    CONSTRAINT "review_cases_selected_match_feature_key"
        UNIQUE (
            "tenant_id",
            "match_feature_id",
            "source_record_id",
            "candidate_source_record_id",
            "candidate_entity_id"
        ),
    CONSTRAINT "review_cases_score_range"
        CHECK ("score" >= 0 AND "score" <= 1)
);

CREATE INDEX "review_cases_tenant_status_created_idx"
ON "review_cases"("tenant_id", "status", "created_at");

CREATE INDEX "review_cases_tenant_candidate_entity_idx"
ON "review_cases"("tenant_id", "candidate_entity_id");

ALTER TABLE "review_cases"
ADD CONSTRAINT "review_cases_tenant_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "review_cases"
ADD CONSTRAINT "review_cases_tenant_source_record_fkey"
FOREIGN KEY ("tenant_id", "source_record_id")
REFERENCES "source_records"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "review_cases"
ADD CONSTRAINT "review_cases_tenant_candidate_record_fkey"
FOREIGN KEY ("tenant_id", "candidate_source_record_id")
REFERENCES "source_records"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "review_cases"
ADD CONSTRAINT "review_cases_tenant_candidate_entity_fkey"
FOREIGN KEY ("tenant_id", "candidate_entity_id")
REFERENCES "entities"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "review_cases"
ADD CONSTRAINT "review_cases_selected_match_feature_fkey"
FOREIGN KEY (
    "tenant_id",
    "match_feature_id",
    "source_record_id",
    "candidate_source_record_id",
    "candidate_entity_id"
)
REFERENCES "match_features" (
    "tenant_id",
    "id",
    "source_record_id",
    "candidate_source_record_id",
    "candidate_entity_id"
)
ON DELETE RESTRICT ON UPDATE NO ACTION;
