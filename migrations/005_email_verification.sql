ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
CREATE TABLE email_verifications (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
