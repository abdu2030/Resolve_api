ALTER TYPE canonical_trigger_operation ADD VALUE 'REVIEW_APPROVED';
ALTER TYPE canonical_trigger_operation ADD VALUE 'REVIEW_REJECTED';
CREATE TYPE review_outcome AS ENUM ('APPROVE', 'REJECT');

ALTER TABLE review_cases ADD COLUMN source_record_version INTEGER,
  ADD COLUMN candidate_record_version INTEGER,
  ADD CONSTRAINT review_cases_source_version_check CHECK (source_record_version > 0),
  ADD CONSTRAINT review_cases_candidate_version_check CHECK (candidate_record_version > 0),
  ADD CONSTRAINT review_cases_tenant_id_key UNIQUE (tenant_id, id);

CREATE TABLE review_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  review_case_id UUID NOT NULL,
  decision review_outcome NOT NULL,
  reason VARCHAR(500) NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_api_key_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  source_record_version INTEGER NOT NULL CHECK (source_record_version > 0),
  candidate_record_version INTEGER NOT NULL CHECK (candidate_record_version > 0),
  candidate_canonical_version INTEGER NOT NULL CHECK (candidate_canonical_version >= 0),
  canonical_version INTEGER NOT NULL CHECK (canonical_version > 0),
  policy_version VARCHAR(50) NOT NULL DEFAULT 'review-v1',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT review_decisions_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT review_decisions_tenant_case_key UNIQUE (tenant_id, review_case_id),
  CONSTRAINT review_decisions_tenant_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT review_decisions_tenant_case_fkey FOREIGN KEY (tenant_id, review_case_id) REFERENCES review_cases(tenant_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT review_decisions_tenant_actor_fkey FOREIGN KEY (tenant_id, actor_api_key_id) REFERENCES api_keys(tenant_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT review_decisions_tenant_entity_fkey FOREIGN KEY (tenant_id, entity_id) REFERENCES entities(tenant_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

ALTER TABLE entity_record_links ADD COLUMN review_decision_id UUID,
  ADD CONSTRAINT entity_record_links_tenant_review_decision_fkey FOREIGN KEY (tenant_id, review_decision_id) REFERENCES review_decisions(tenant_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE entity_canonical_versions ADD COLUMN review_decision_id UUID,
  ADD CONSTRAINT entity_canonical_versions_tenant_review_decision_fkey FOREIGN KEY (tenant_id, review_decision_id) REFERENCES review_decisions(tenant_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE FUNCTION protect_review_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Review decisions are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER review_decisions_append_only BEFORE UPDATE OR DELETE ON review_decisions
FOR EACH ROW EXECUTE FUNCTION protect_review_decision();
