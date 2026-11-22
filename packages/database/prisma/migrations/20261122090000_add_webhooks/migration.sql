CREATE TYPE "webhook_delivery_status" AS ENUM ('PENDING', 'RUNNING', 'DELIVERED', 'DEAD_LETTER');
CREATE TYPE "webhook_attempt_outcome" AS ENUM ('STARTED', 'DELIVERED', 'FAILED', 'INTERRUPTED');

CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "events" TEXT[] NOT NULL,
    "encrypted_secret" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_endpoints_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "webhook_endpoints_has_events" CHECK (cardinality("events") > 0)
);

CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "data" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_events_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "webhook_endpoints_tenant_id_key" ON "webhook_endpoints" ("tenant_id", "id");
CREATE UNIQUE INDEX "webhook_endpoints_tenant_url_key" ON "webhook_endpoints" ("tenant_id", "url");
CREATE UNIQUE INDEX "webhook_events_tenant_id_key" ON "webhook_events" ("tenant_id", "id");

CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "status" "webhook_delivery_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "replay_start_attempt" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(50),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_deliveries_endpoint_fkey" FOREIGN KEY ("tenant_id", "endpoint_id") REFERENCES "webhook_endpoints" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "webhook_deliveries_event_fkey" FOREIGN KEY ("tenant_id", "event_id") REFERENCES "webhook_events" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "webhook_deliveries_attempt_bounds" CHECK ("replay_start_attempt" >= 0 AND "attempts" >= "replay_start_attempt")
);

CREATE UNIQUE INDEX "webhook_deliveries_tenant_id_key" ON "webhook_deliveries" ("tenant_id", "id");
CREATE UNIQUE INDEX "webhook_deliveries_event_endpoint_key" ON "webhook_deliveries" ("tenant_id", "endpoint_id", "event_id");
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" ("status", "available_at", "id");
CREATE INDEX "webhook_deliveries_endpoint_created_idx" ON "webhook_deliveries" ("tenant_id", "endpoint_id", "created_at" DESC, "id" DESC);
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" ("tenant_id", "event_id");

CREATE TABLE "webhook_attempts" (
    "tenant_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "outcome" "webhook_attempt_outcome" NOT NULL DEFAULT 'STARTED',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "http_status" INTEGER,
    "error_code" VARCHAR(50),
    CONSTRAINT "webhook_attempts_pkey" PRIMARY KEY ("tenant_id", "delivery_id", "number"),
    CONSTRAINT "webhook_attempts_delivery_fkey" FOREIGN KEY ("tenant_id", "delivery_id") REFERENCES "webhook_deliveries" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "webhook_attempts_number_positive" CHECK ("number" > 0)
);
