CREATE TYPE "audit_action" AS ENUM (
    'api_key.bootstrapped',
    'source.registered',
    'review.resolved',
    'entity.merged',
    'entity.split',
    'entity.merge_reversed',
    'webhook_endpoint.registered',
    'webhook_delivery.replayed'
);

CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "actor_api_key_id" UUID,
    "action" "audit_action" NOT NULL,
    "resource_id" UUID NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_events_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "audit_events_tenant_actor_fkey" FOREIGN KEY ("tenant_id", "actor_api_key_id") REFERENCES "api_keys"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "audit_events_actor_required_check" CHECK (("actor_api_key_id" IS NULL) = ("action" = 'api_key.bootstrapped')),
    CONSTRAINT "audit_events_data_object_check" CHECK (jsonb_typeof("data") = 'object')
);

CREATE INDEX "audit_events_tenant_created_idx" ON "audit_events"("tenant_id", "created_at" DESC, "id" DESC);

CREATE FUNCTION "reject_audit_event_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are append-only'
        USING ERRCODE = '23514', CONSTRAINT = 'audit_events_append_only';
END;
$$;

CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_audit_event_mutation"();
