CREATE TYPE "job_status" AS ENUM ('QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'QUEUED',
    "total_records" INTEGER NOT NULL,
    "processed_records" INTEGER NOT NULL DEFAULT 0,
    "failed_records" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(64),
    "dispatch_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "jobs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "jobs_progress_check" CHECK (
        "total_records" BETWEEN 1 AND 100 AND "processed_records" BETWEEN 0 AND "total_records"
        AND "failed_records" BETWEEN 0 AND "processed_records" AND "attempts" >= 0
    ),
    CONSTRAINT "jobs_terminal_check" CHECK (
        ("finished_at" IS NOT NULL) = ("status" IN ('SUCCEEDED', 'FAILED'))
        AND ("error_code" IS NOT NULL) = ("status" = 'FAILED')
        AND ("status" <> 'SUCCEEDED' OR ("processed_records" = "total_records" AND "failed_records" = 0))
    )
);

CREATE UNIQUE INDEX "jobs_tenant_id_key" ON "jobs"("tenant_id", "id");
CREATE INDEX "jobs_dispatch_idx" ON "jobs"("status", "dispatch_after", "id");

CREATE TABLE "job_records" (
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB,
    "error_code" VARCHAR(64),
    CONSTRAINT "job_records_pkey" PRIMARY KEY ("tenant_id", "job_id", "position"),
    CONSTRAINT "job_records_tenant_job_fkey" FOREIGN KEY ("tenant_id", "job_id") REFERENCES "jobs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "job_records_outcome_check" CHECK ("position" BETWEEN 0 AND 99 AND ("result" IS NULL OR "error_code" IS NULL))
);
