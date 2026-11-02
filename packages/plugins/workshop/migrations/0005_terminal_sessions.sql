-- workshop 0005: the terminal into a bot's sandbox (PLAN P7-09). Forward-only: never edit once applied.
--
-- One row is one terminal an admin asked for: who, which bot, which sandbox run, when it started and ended, why it ended, how many bytes went each way, how many credentials were revoked as
-- it opened, and the recorded screen text (what the shell printed, escape codes removed, secrets redacted, cut at a size limit). The row is written when the terminal is asked for
-- (`waiting`), moves to `open` when the page connects its socket (once), and to `ended` when the shell is gone. At most ONE terminal per admin is `waiting` or `open` at a time: the
-- partial unique index below is the rule, so two requests racing for a second terminal cannot both win.
--
-- Admins read every recording of their workspace (the point of a record is that somebody else can look). The shell's bookkeeping (open, bytes, the end, the transcript) is written by the
-- server as the system role: the person at the keyboard never writes the record of their own session. A recording is never deleted by this plugin; the retention sweep does not cover it
-- yet (docs/plugins/workshop.md says so).
--
-- A record outlives the things it describes: deleting a team or a bot sets `team_id` / `bot_id` to NULL (the bot's name stays in `bot_slug`), it never deletes an admin's recording. Only deleting
-- the whole workspace (or the admin's own account) removes rows. And the database itself refuses a `run_id` that is not a rehearsal run of the same bot (the trigger below), so no code path can
-- tie a terminal to a real run.
CREATE TABLE app.terminal_sessions (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id         uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id              uuid REFERENCES app.teams (id) ON DELETE SET NULL,
  bot_id               uuid REFERENCES app.bots (id) ON DELETE SET NULL,
  bot_slug             text NOT NULL CHECK (char_length(bot_slug) BETWEEN 1 AND 100),
  admin_id             uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  run_id               uuid REFERENCES app.bot_runs (id) ON DELETE SET NULL,
  sandbox_kind         text NOT NULL DEFAULT 'rehearsal' CHECK (sandbox_kind IN ('rehearsal')),
  status               text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'open', 'ended')),
  end_reason           text CHECK (end_reason IS NULL OR end_reason IN ('closed', 'ended_by_admin', 'idle', 'max_duration', 'output_limit', 'input_limit', 'session_ended', 'server_stop', 'unused', 'error')),
  credentials_revoked  integer NOT NULL DEFAULT 0 CHECK (credentials_revoked >= 0),
  bytes_in             bigint NOT NULL DEFAULT 0 CHECK (bytes_in >= 0),
  bytes_out            bigint NOT NULL DEFAULT 0 CHECK (bytes_out >= 0),
  transcript           text NOT NULL DEFAULT '' CHECK (char_length(transcript) <= 262144 + 400),
  transcript_truncated boolean NOT NULL DEFAULT false,
  started_at           timestamptz,
  ended_at             timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'ended') = (end_reason IS NOT NULL)),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE INDEX terminal_sessions_workspace ON app.terminal_sessions (workspace_id);
CREATE INDEX terminal_sessions_team ON app.terminal_sessions (team_id);
CREATE INDEX terminal_sessions_bot ON app.terminal_sessions (bot_id, created_at DESC);
CREATE INDEX terminal_sessions_admin ON app.terminal_sessions (admin_id, created_at DESC);
CREATE INDEX terminal_sessions_run ON app.terminal_sessions (run_id) WHERE run_id IS NOT NULL;
-- a terminal is only ever tied to a rehearsal run of its own bot, whatever wrote the row (the server, a repair script, a future route)
-- (security definer: the check must see the run whoever writes the row; an admin who is not on the bot's team could not read the run through its row policy and would be refused wrongly)
CREATE FUNCTION app.terminal_sessions_sandbox_only() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  -- the bot named on the row is a bot of the team and the workspace named on it (an admin cannot file a terminal under another team's name)
  IF NEW.bot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.bots b WHERE b.id = NEW.bot_id AND b.team_id IS NOT DISTINCT FROM NEW.team_id AND b.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'a terminal can only be filed under the team and workspace of its bot' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.bot_runs r WHERE r.id = NEW.run_id AND r.rehearsal AND r.trigger_type = 'conversation' AND r.bot_id = NEW.bot_id
  ) THEN
    RAISE EXCEPTION 'a terminal can only be tied to a rehearsal run of its own bot' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER terminal_sessions_sandbox_only BEFORE INSERT OR UPDATE OF run_id ON app.terminal_sessions
  FOR EACH ROW EXECUTE FUNCTION app.terminal_sessions_sandbox_only();
-- the one-terminal-per-admin rule
CREATE UNIQUE INDEX terminal_sessions_one_live_per_admin ON app.terminal_sessions (admin_id) WHERE status IN ('waiting', 'open');
COMMENT ON TABLE app.terminal_sessions IS 'rls: workspace — W: a terminal an admin opened into a bot''s sandbox: who, which bot, when, why it ended and the redacted screen text; workspace admins read every row; the server writes the bookkeeping as the system role.';

ALTER TABLE app.terminal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.terminal_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY terminal_sessions_select ON app.terminal_sessions FOR SELECT
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_workspace_admin())));
CREATE POLICY terminal_sessions_insert ON app.terminal_sessions FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_workspace_admin()) AND admin_id = (SELECT app.actor()) AND status = 'waiting'));
CREATE POLICY terminal_sessions_update ON app.terminal_sessions FOR UPDATE
  USING ((SELECT app.is_system()))
  WITH CHECK ((SELECT app.is_system()));
CREATE POLICY terminal_sessions_delete ON app.terminal_sessions FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE ON app.terminal_sessions TO manythreads_app;
