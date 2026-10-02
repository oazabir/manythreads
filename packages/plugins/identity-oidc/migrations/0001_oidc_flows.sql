-- identity-oidc: in-flight sign-in attempts (authorization code + PKCE). One row per `start`; the callback consumes it
-- (DELETE ... RETURNING), so a state value works once. UNLOGGED: losing the rows in a crash only means a person
-- clicks the sign-in button again. The row holds the nonce and the PKCE verifier, so only the system role may touch it;
-- the browser gets the state value itself in an HttpOnly cookie, the table keeps only its sha256.
CREATE UNLOGGED TABLE app.oidc_flows (
  state_hash    bytea PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  provider_id   uuid NOT NULL REFERENCES app.auth_providers (id) ON DELETE CASCADE,
  nonce         text NOT NULL,
  code_verifier text NOT NULL,
  return_to     text NOT NULL DEFAULT '/',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX oidc_flows_provider ON app.oidc_flows (provider_id);
CREATE INDEX oidc_flows_workspace ON app.oidc_flows (workspace_id);
CREATE INDEX oidc_flows_expires ON app.oidc_flows (expires_at);

ALTER TABLE app.oidc_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.oidc_flows FORCE ROW LEVEL SECURITY;
CREATE POLICY oidc_flows_system ON app.oidc_flows FOR ALL USING (app.is_system()) WITH CHECK (app.is_system());

COMMENT ON TABLE app.oidc_flows IS 'rls: system — S: UNLOGGED in-flight OIDC sign-ins (state hash, nonce, PKCE verifier); no privilege for manythreads_app.';
