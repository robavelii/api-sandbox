CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  action text NOT NULL,
  resource_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace ON audit_events(organization_id,id DESC);
CREATE INDEX audit_events_retention ON audit_events(created_at,id);
CREATE INDEX request_logs_retention ON request_logs(created_at,id);
CREATE INDEX auth_sessions_retention ON auth_sessions(expires_at);
CREATE INDEX auth_attempts_retention ON auth_attempts(window_start);
CREATE INDEX verification_retention ON email_verifications(expires_at);
CREATE INDEX invitation_retention ON workspace_invitations(expires_at);
CREATE INDEX delivery_retention ON webhook_deliveries(updated_at) WHERE status IN ('delivered','failed');
CREATE INDEX event_retention ON webhook_events(created_at) WHERE fanout_at IS NOT NULL;

-- Use fixed allowlisted fields, never row snapshots: rows contain secrets.
CREATE FUNCTION audit_membership_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value memberships;
BEGIN
  IF TG_OP='DELETE' THEN value:=OLD; ELSE value:=NEW; END IF;
  INSERT INTO audit_events(organization_id,action,resource_id,metadata)
  VALUES(value.organization_id,'membership.'||lower(TG_OP),value.user_id,
    CASE WHEN TG_OP='DELETE' THEN jsonb_build_object('previous_role',OLD.role)
         WHEN TG_OP='UPDATE' THEN jsonb_build_object('previous_role',OLD.role,'role',NEW.role)
         ELSE jsonb_build_object('role',NEW.role) END);
  RETURN NULL;
END;
$$;
CREATE TRIGGER membership_audit AFTER INSERT OR UPDATE OR DELETE ON memberships
FOR EACH ROW EXECUTE FUNCTION audit_membership_change();

CREATE FUNCTION audit_sandbox_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.api_key_hash IS DISTINCT FROM OLD.api_key_hash THEN
    INSERT INTO audit_events(organization_id,action,resource_id)
    VALUES(NEW.organization_id,'sandbox.key_rotated',NEW.id);
  END IF;
  IF NEW.approved IS DISTINCT FROM OLD.approved THEN
    INSERT INTO audit_events(organization_id,action,resource_id,metadata)
    VALUES(NEW.organization_id,'sandbox.approval_changed',NEW.id,jsonb_build_object('approved',NEW.approved));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER sandbox_audit AFTER UPDATE ON sandboxes
FOR EACH ROW WHEN (NEW.api_key_hash IS DISTINCT FROM OLD.api_key_hash OR NEW.approved IS DISTINCT FROM OLD.approved)
EXECUTE FUNCTION audit_sandbox_change();

CREATE FUNCTION audit_scenario_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE organization uuid;
BEGIN
  SELECT organization_id INTO organization FROM sandboxes WHERE id=NEW.sandbox_id;
  IF TG_TABLE_NAME='sandbox_versions' THEN
    IF TG_OP='INSERT' THEN
      INSERT INTO audit_events(organization_id,action,resource_id)
      VALUES(organization,'scenario.version_created',NEW.id);
    ELSIF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      INSERT INTO audit_events(organization_id,action,resource_id)
      VALUES(organization,'scenario.version_approved',NEW.id);
    END IF;
  ELSE
    IF NEW.version_id IS DISTINCT FROM OLD.version_id THEN
      INSERT INTO audit_events(organization_id,action,resource_id,metadata)
      VALUES(organization,'session.version_changed',NEW.id,jsonb_build_object('version_id',NEW.version_id));
    ELSIF NEW.generation IS DISTINCT FROM OLD.generation THEN
      INSERT INTO audit_events(organization_id,action,resource_id)
      VALUES(organization,'session.reset',NEW.id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER scenario_version_audit AFTER INSERT OR UPDATE ON sandbox_versions
FOR EACH ROW EXECUTE FUNCTION audit_scenario_change();
CREATE TRIGGER scenario_session_audit AFTER UPDATE ON simulation_sessions
FOR EACH ROW WHEN (NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.generation IS DISTINCT FROM OLD.generation)
EXECUTE FUNCTION audit_scenario_change();
