CREATE TABLE users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL, request_limit integer NOT NULL DEFAULT 10000, sandbox_limit integer NOT NULL DEFAULT 5);
CREATE TABLE memberships (user_id uuid REFERENCES users(id), organization_id uuid REFERENCES organizations(id), role text NOT NULL CHECK(role IN ('owner','member')), PRIMARY KEY(user_id,organization_id));
CREATE TABLE auth_sessions (token_hash text PRIMARY KEY, user_id uuid REFERENCES users(id), expires_at timestamptz NOT NULL);
CREATE TABLE sandboxes (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL, contract jsonb NOT NULL, approved boolean NOT NULL DEFAULT false, api_key_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX sandboxes_org ON sandboxes(organization_id);
CREATE TABLE simulation_sessions (id uuid PRIMARY KEY, sandbox_id uuid NOT NULL REFERENCES sandboxes(id), name text NOT NULL, scenario text NOT NULL DEFAULT 'success' CHECK(scenario IN ('success','error','rate_limit','delay')), counter integer NOT NULL DEFAULT 0, generation integer NOT NULL DEFAULT 0, UNIQUE(sandbox_id,name));
CREATE TABLE resources (session_id uuid REFERENCES simulation_sessions(id), kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(session_id,kind,id));
CREATE TABLE request_logs (id bigserial PRIMARY KEY, session_id uuid NOT NULL REFERENCES simulation_sessions(id), method text NOT NULL, path text NOT NULL, status integer NOT NULL, detail text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX logs_session ON request_logs(session_id,id DESC);
CREATE TABLE monthly_usage (organization_id uuid REFERENCES organizations(id), month date NOT NULL, requests integer NOT NULL DEFAULT 0, PRIMARY KEY(organization_id,month));

CREATE TABLE auth_attempts (address text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL);
