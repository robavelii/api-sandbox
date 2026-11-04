CREATE TABLE platform_api_keys (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scope text NOT NULL DEFAULT 'read' CHECK(scope='read'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX platform_keys_org ON platform_api_keys(organization_id);
