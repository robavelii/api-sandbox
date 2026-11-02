CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES sandboxes(id),
  url text NOT NULL,
  description text NOT NULL DEFAULT '',
  secret_ciphertext text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sandbox_id,id)
);
CREATE INDEX webhook_endpoints_sandbox ON webhook_endpoints(sandbox_id,active);

ALTER TABLE simulation_sessions
ADD CONSTRAINT sessions_sandbox_identity UNIQUE(sandbox_id,id);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES sandboxes(id),
  session_id uuid NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  fanout_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(sandbox_id,session_id)
    REFERENCES simulation_sessions(sandbox_id,id)
);
CREATE INDEX webhook_events_ready ON webhook_events(available_at,id) WHERE fanout_at IS NULL;

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES webhook_events(id),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivering','delivered','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  worker_token uuid,
  response_status integer,
  response_excerpt text,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,endpoint_id)
);
CREATE INDEX webhook_deliveries_ready ON webhook_deliveries(next_attempt_at,id)
WHERE status IN ('pending','delivering');
