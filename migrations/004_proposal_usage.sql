CREATE TABLE proposal_usage (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  month date NOT NULL,
  requests integer NOT NULL CHECK (requests BETWEEN 0 AND 100),
  PRIMARY KEY (organization_id, month)
);
