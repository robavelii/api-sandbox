CREATE TABLE password_recoveries (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE recovery_requests (
  email_hash text PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now()
);
