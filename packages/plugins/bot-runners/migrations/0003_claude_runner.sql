-- bot-runners 0003: the Claude Code runner's sign-in bookkeeping and its use per team (PLAN.md Phase 19, P19-06 and P19-07). Forward-only and additive: a server one
-- version back still runs against it.
--
--   bot_runners.credentials_sha256   SHA-256 of the uploaded sign-in file's bytes (hex). The file itself is never in the database: it lives in the pod's Secret.
--   bot_runners.signins_ack_by/_at   the admin who ticked "this file also holds other sign-ins, stored as they are", and when.
--   bot_runners (workspace_id, login_id) is unique when set: a login another runner already holds is refused (login_id = a keyed hash, never the token).
--   bot_runner_usage                 what a Claude Code runner did for each team each day: runs, seconds, and the CLI's own cost figure (its number, not a price).

ALTER TABLE app.bot_runners
  ADD COLUMN credentials_sha256 text CHECK (credentials_sha256 IS NULL OR credentials_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN signins_ack_by uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  ADD COLUMN signins_ack_at timestamptz;
CREATE INDEX bot_runners_signins_ack_by ON app.bot_runners (signins_ack_by) WHERE signins_ack_by IS NOT NULL;
CREATE UNIQUE INDEX bot_runners_login ON app.bot_runners (workspace_id, login_id) WHERE login_id IS NOT NULL;

CREATE TABLE app.bot_runner_usage (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  runner_id    uuid NOT NULL REFERENCES app.bot_runners (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  day          date NOT NULL,
  runs         integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  seconds      integer NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  cli_cost     numeric NOT NULL DEFAULT 0 CHECK (cli_cost >= 0),
  PRIMARY KEY (runner_id, team_id, day)
);
CREATE INDEX bot_runner_usage_workspace ON app.bot_runner_usage (workspace_id);
CREATE INDEX bot_runner_usage_team ON app.bot_runner_usage (team_id);
COMMENT ON TABLE app.bot_runner_usage IS 'rls: workspace — W: workspace admins read; only the system role writes. Per runner, team and day: runs, seconds and the Claude CLI''s own cost figure.';

ALTER TABLE app.bot_runner_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_runner_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY bot_runner_usage_read ON app.bot_runner_usage FOR SELECT
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY bot_runner_usage_system ON app.bot_runner_usage FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- the system actor runs as manythreads_app with app.is_system() true; the policy above is what keeps every other caller from writing
GRANT SELECT, INSERT, UPDATE, DELETE ON app.bot_runner_usage TO manythreads_app;
