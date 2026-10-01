-- identity-password: the one-time first-admin link (spec section 16, step 0). Only the sha256 of the token is stored;
-- the token itself exists once, in the single log line printed at server start while no workspace exists.
CREATE TABLE app.bootstrap_tokens (
  token_hash   bytea PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  used_at      timestamptz,
  workspace_id uuid REFERENCES app.workspaces (id) ON DELETE SET NULL
);
CREATE INDEX bootstrap_tokens_workspace ON app.bootstrap_tokens (workspace_id) WHERE workspace_id IS NOT NULL;
COMMENT ON TABLE app.bootstrap_tokens IS 'rls: system — S: sha256 of the one-time first-admin link; no privilege for manythreads_app.';

ALTER TABLE app.bootstrap_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bootstrap_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY bootstrap_tokens_system ON app.bootstrap_tokens FOR ALL USING (app.is_system()) WITH CHECK (app.is_system());

REVOKE ALL ON app.bootstrap_tokens FROM PUBLIC, manythreads_app;
