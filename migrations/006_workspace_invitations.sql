CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_workspace ON workspace_invitations(organization_id,expires_at);
