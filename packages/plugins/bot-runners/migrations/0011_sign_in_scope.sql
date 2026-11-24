-- bot-runners 0011: one sign-in for all teams of a runner, or one per team (PLAN.md P35-10a, docs/plans/per-team-sign-in.md). Forward-only and additive: a server one
-- version back never writes the new column (its inserts take the default, `shared`, which is how every runner works today) and never reads the new table.
--
--   bot_runners.sign_in_scope       `shared`: one sign-in for every team of the runner (today). `per_team`: each team of the runner signs in with an account of its own.
--                                   Only a Claude Code or Codex pod runner (`claude_cli`, `codex_cli`) or a server runner whose agent is Claude Code or Codex may be
--                                   `per_team` (CHECK bot_runners_sign_in_scope_kind: a rule kept only in a route drifts, MISTAKES). Admin-only, never in a team view.
--   app.bot_runner_team_signins     for a `per_team` runner, the last known sign-in state of each team it serves: written by the system role only (the pod controller's pass,
--                                   the Runners page's reads through the system actor), read by workspace admins (the page) and by the run resolver, so no request waits
--                                   on a live probe of every team. A row says nothing about the account: only signed in, signed out, refused or limited, and when that was last seen.
ALTER TABLE app.bot_runners
  ADD COLUMN sign_in_scope text NOT NULL DEFAULT 'shared' CHECK (sign_in_scope IN ('shared', 'per_team')),
  ADD CONSTRAINT bot_runners_sign_in_scope_kind CHECK (
    sign_in_scope = 'shared' OR kind IN ('claude_cli', 'codex_cli') OR (kind = 'server_agent' AND agent IN ('claude-code', 'codex'))
  );

COMMENT ON COLUMN app.bot_runners.sign_in_scope IS 'Who signs in (docs/plans/per-team-sign-in.md): shared = one sign-in for every team of the runner; per_team = each team signs in on its own (Claude Code or Codex runners only, CHECK bot_runners_sign_in_scope_kind). Set by PUT /api/admin/bot-runners/:id/sign-in-scope. Admin-only, never in a team view.';

-- bot_runner_team_signins (W read, S write) -----------------------------------------------------------------------------------------------------------
CREATE TABLE app.bot_runner_team_signins (
  runner_id  uuid NOT NULL REFERENCES app.bot_runners (id) ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  -- signed_in / signed_out: what the team's pod or the Runners page last saw. refused: a run met a sign-in the provider refused; only a real sign-in on the page clears it
  -- (the pod's own status may still read its old file as signed in). limited: the team's plan limit was reached; its runs wait until paused_until.
  state        text NOT NULL CHECK (state IN ('signed_in', 'signed_out', 'refused', 'limited')),
  paused_until timestamptz,
  checked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (runner_id, team_id)
);
CREATE INDEX bot_runner_team_signins_team ON app.bot_runner_team_signins (team_id);
COMMENT ON TABLE app.bot_runner_team_signins IS 'rls: workspace — W: workspace admins read; only the system role writes. Per runner and team of a per_team runner: signed in or out, as last seen by the pod controller or the Runners page. No account, no secret.';

-- A team's row belongs to the runner's workspace. Read through the definer role, so what the caller may see cannot fool it.
CREATE FUNCTION app.bot_runner_team_signins_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.bot_runners r JOIN app.teams t ON t.workspace_id = r.workspace_id WHERE r.id = NEW.runner_id AND t.id = NEW.team_id
  ) THEN
    RAISE EXCEPTION 'bot_runner_team_signins.team_id must belong to the runner''s workspace' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bot_runner_team_signins_guard BEFORE INSERT OR UPDATE OF runner_id, team_id ON app.bot_runner_team_signins
  FOR EACH ROW EXECUTE FUNCTION app.bot_runner_team_signins_guard();

-- Row level security: the same shape as bot_runner_usage (admins read, the system writes), with the runner set built once per statement as bot_runner_teams does.
ALTER TABLE app.bot_runner_team_signins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_runner_team_signins FORCE ROW LEVEL SECURITY;
CREATE POLICY bot_runner_team_signins_read ON app.bot_runner_team_signins FOR SELECT
  USING ((SELECT app.is_system()) OR runner_id = ANY ((SELECT coalesce(array_agg(r.id), '{}') FROM app.bot_runners r)::uuid[]));
CREATE POLICY bot_runner_team_signins_system ON app.bot_runner_team_signins FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- the app role only reads (as bot_runner_usage after 0004); the system role holds its own table privileges
GRANT SELECT ON app.bot_runner_team_signins TO manythreads_app;

-- The scope switch (PUT /api/admin/bot-runners/:id/sign-in-scope) clears a runner's stored team states in the admin's own transaction, so they go exactly when the switch
-- commits and stay when it fails. The app role may not write the table; this narrow door may, for a workspace admin of the runner's workspace only (checked with the lookup
-- functions: inside a definer function app.is_system() is true).
CREATE FUNCTION app.bot_runner_team_signins_clear(p_runner_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF coalesce(app.lookup_workspace_role() IN ('owner', 'admin'), false) IS NOT TRUE
     OR NOT EXISTS (SELECT 1 FROM app.bot_runners r WHERE r.id = p_runner_id AND r.workspace_id = app.workspace_id()) THEN
    RAISE EXCEPTION 'only a workspace admin clears the team sign-ins of a runner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM app.bot_runner_team_signins WHERE runner_id = p_runner_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.bot_runner_team_signins_guard() OWNER TO manythreads_system;
ALTER FUNCTION app.bot_runner_team_signins_clear(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.bot_runner_team_signins_guard(), app.bot_runner_team_signins_clear(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bot_runner_team_signins_clear(uuid) TO manythreads_app;
