CREATE TABLE sandbox_versions (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES sandboxes(id),
  number integer NOT NULL,
  definition jsonb NOT NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sandbox_id,number),
  UNIQUE(sandbox_id,id)
);
INSERT INTO sandbox_versions(id,sandbox_id,number,definition,approved_at)
SELECT id,id,1,'{"version":1,"name":"Default behavior","seed":"spectwin","clock":"2026-01-01T00:00:00.000Z","idempotency":"replay","rules":[]}'::jsonb,CASE WHEN approved THEN now() ELSE NULL END FROM sandboxes;
ALTER TABLE simulation_sessions ADD COLUMN version_id uuid;
UPDATE simulation_sessions SET version_id=sandbox_id;
ALTER TABLE simulation_sessions ALTER COLUMN version_id SET NOT NULL;
ALTER TABLE simulation_sessions ADD CONSTRAINT session_version_scope FOREIGN KEY(sandbox_id,version_id) REFERENCES sandbox_versions(sandbox_id,id);
ALTER TABLE simulation_sessions ADD COLUMN rule_counts jsonb NOT NULL DEFAULT '{}';
ALTER TABLE simulation_sessions ADD COLUMN clock timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00.000Z';
CREATE TABLE idempotent_results (
  session_id uuid NOT NULL REFERENCES simulation_sessions(id),
  key_hash text NOT NULL,
  fingerprint text NOT NULL,
  status integer NOT NULL,
  result jsonb,
  PRIMARY KEY(session_id,key_hash)
);
ALTER TABLE request_logs ADD COLUMN version_id uuid REFERENCES sandbox_versions(id);
ALTER TABLE request_logs ADD COLUMN simulated_at timestamptz;
CREATE FUNCTION immutable_sandbox_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id OR NEW.number IS DISTINCT FROM OLD.number OR NEW.definition IS DISTINCT FROM OLD.definition OR NEW.created_at IS DISTINCT FROM OLD.created_at OR (OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'Scenario versions are immutable; create a new version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_version BEFORE UPDATE ON sandbox_versions FOR EACH ROW EXECUTE FUNCTION immutable_sandbox_version();
