-- bot-runners 0001: the runner catalog (PLAN.md Phase 19, P19-02, appendix A.12). Forward-only: never edit once applied.
--
-- A runner is a place bots can run, set up once by a workspace admin: a Hermes gateway, the team Hermes pod, the Claude Code pod, the Codex pod or the LLM
-- gateway. Anyone who may edit a bot picks one of the runners available to their team.
--
--   bot_runners        one row per runner, owned by the workspace. No token, key or sign-in is a column: a Hermes gateway's key is envelope-encrypted in
--                      app.secrets (secret_id), and a Claude or Codex sign-in lives in the pod's own Secret. Workspace admins read and write; nobody else.
--   bot_runner_teams   which teams may use a runner when its all_teams flag is false. The list is the permission. Admins only.
--
-- What a team sees is not these tables but app.bot_runners_for_team(team_id): a SECURITY DEFINER function that returns the name, label, kind, state, whether
-- it is the default, the owner's name and the plan label, and nothing else (no address, key, node or expiry). The caller must belong to that team.
--
-- Kinds: all five of the plan are allowed here, but only hermes_gateway, hermes_pod and llm_gateway can be made by the API until the pod tasks are built.
-- Ordering: references app.workspaces, app.teams, app.actors and app.secrets (kernel and teams), so the manifest depends on teams.

-- bot_runners (W) -----------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.bot_runners (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id           uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- the slug a BOT.md `placement.runs_on` uses; it never changes
  name                   text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  label                  text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 80),
  kind                   text NOT NULL CHECK (kind IN ('hermes_gateway', 'hermes_pod', 'claude_cli', 'codex_cli', 'llm_gateway')),
  enabled                boolean NOT NULL DEFAULT true,
  is_default             boolean NOT NULL DEFAULT false,
  all_teams              boolean NOT NULL DEFAULT false,
  base_url               text CHECK (base_url IS NULL OR base_url ~ '^https?://'),
  secret_id              uuid REFERENCES app.secrets (id),
  profile_rule           text CHECK (profile_rule IS NULL OR position('{bot}' IN profile_rule) > 0),
  node                   text,
  model_alias            text,
  owner_actor_id         uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  plan_label             text,
  credentials_expires_at timestamptz,
  uploaded_at            timestamptz,
  login_id               text,
  terms_accepted_by      uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  terms_accepted_at      timestamptz,
  max_concurrent         integer CHECK (max_concurrent IS NULL OR max_concurrent BETWEEN 1 AND 4),
  status                 text NOT NULL DEFAULT 'not_set_up'
                           CHECK (status IN ('not_set_up', 'waiting_for_sign_in', 'starting', 'ready', 'needs_sign_in', 'waiting_for_node', 'moving', 'paused', 'off')),
  paused_until           timestamptz,
  status_detail          text,
  last_checked_at        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
-- at most one default runner per workspace
CREATE UNIQUE INDEX bot_runners_one_default ON app.bot_runners (workspace_id) WHERE is_default;
CREATE INDEX bot_runners_secret ON app.bot_runners (secret_id) WHERE secret_id IS NOT NULL;
CREATE INDEX bot_runners_owner ON app.bot_runners (owner_actor_id) WHERE owner_actor_id IS NOT NULL;
CREATE INDEX bot_runners_terms_by ON app.bot_runners (terms_accepted_by) WHERE terms_accepted_by IS NOT NULL;
COMMENT ON TABLE app.bot_runners IS 'rls: workspace — W: workspace admins read and write; teams read only through app.bot_runners_for_team (name, label, kind, state, default, owner name, plan label); the key is secret_id, never a column.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, secret_id ON app.bot_runners
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- bot_runner_teams (W) ------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.bot_runner_teams (
  runner_id uuid NOT NULL REFERENCES app.bot_runners (id) ON DELETE CASCADE,
  team_id   uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  PRIMARY KEY (runner_id, team_id)
);
CREATE INDEX bot_runner_teams_team ON app.bot_runner_teams (team_id);
COMMENT ON TABLE app.bot_runner_teams IS 'rls: workspace — W: workspace admins read and write; the teams that may use a runner whose all_teams is false (the list is the permission).';

-- A team on a runner's list belongs to the runner's workspace. The check reads other rows through the definer role, so it cannot be fooled by what the caller is allowed to see.
CREATE FUNCTION app.bot_runner_teams_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.bot_runners r JOIN app.teams t ON t.workspace_id = r.workspace_id WHERE r.id = NEW.runner_id AND t.id = NEW.team_id
  ) THEN
    RAISE EXCEPTION 'bot_runner_teams.team_id must belong to the runner''s workspace' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bot_runner_teams_guard BEFORE INSERT OR UPDATE OF runner_id, team_id ON app.bot_runner_teams
  FOR EACH ROW EXECUTE FUNCTION app.bot_runner_teams_guard();

-- Row level security: workspace admins only (and the system role, for the resolver and the jobs) ------------------------------------------------------
ALTER TABLE app.bot_runners ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_runners FORCE ROW LEVEL SECURITY;
CREATE POLICY bot_runners_admin ON app.bot_runners FOR ALL
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.bot_runners TO manythreads_app;

ALTER TABLE app.bot_runner_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_runner_teams FORCE ROW LEVEL SECURITY;
-- the runners an admin can see are the ones whose list an admin can see; the set is built once per statement, not once per row
CREATE POLICY bot_runner_teams_admin ON app.bot_runner_teams FOR ALL
  USING ((SELECT app.is_system()) OR runner_id = ANY ((SELECT coalesce(array_agg(r.id), '{}') FROM app.bot_runners r)::uuid[]))
  WITH CHECK ((SELECT app.is_system()) OR runner_id = ANY ((SELECT coalesce(array_agg(r.id), '{}') FROM app.bot_runners r)::uuid[]));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.bot_runner_teams TO manythreads_app;

-- What a team sees ----------------------------------------------------------------------------------------------------------------------------------
-- The runners available to a team (all_teams, or the team is on the list), with nothing but name, label, kind, state, default flag, owner name and plan
-- label, and how many teams share it. A disabled runner reads `off`. The caller must belong to the team (a workspace admin may ask for any team of their workspace); everyone else
-- gets the same refusal whether the team exists or not. Inside a definer function app.is_system() is true, so the caller is checked with the lookup
-- functions, which read the caller's own settings.
CREATE FUNCTION app.bot_runners_for_team(p_team_id uuid)
  RETURNS TABLE (name text, label text, kind text, status text, is_default boolean, owner_name text, plan_label text, shared_with integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws uuid := app.workspace_id();
BEGIN
  IF app.actor() IS NULL OR v_ws IS NULL
     OR NOT (app.lookup_team_role(p_team_id) IS NOT NULL OR coalesce(app.lookup_workspace_role() IN ('owner', 'admin'), false))
     OR NOT EXISTS (SELECT 1 FROM app.teams t WHERE t.id = p_team_id AND t.workspace_id = v_ws) THEN
    RAISE EXCEPTION 'you cannot see the runners of this team' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT r.name,
         r.label,
         r.kind,
         CASE WHEN r.enabled THEN r.status ELSE 'off' END,
         r.is_default,
         pe.display_name,
         r.plan_label,
         -- how many teams may use it: every team of the workspace when it is open to all, else the length of its list (a count, never the names)
         CASE WHEN r.all_teams THEN (SELECT count(*)::int FROM app.teams t WHERE t.workspace_id = r.workspace_id)
              ELSE (SELECT count(*)::int FROM app.bot_runner_teams rt WHERE rt.runner_id = r.id) END
    FROM app.bot_runners r
    LEFT JOIN app.actors ac ON ac.id = r.owner_actor_id AND ac.kind = 'person' AND ac.workspace_id = r.workspace_id
    LEFT JOIN app.people pe ON pe.id = ac.ref_id AND pe.workspace_id = r.workspace_id
   WHERE r.workspace_id = v_ws
     AND (r.all_teams OR EXISTS (SELECT 1 FROM app.bot_runner_teams rt WHERE rt.runner_id = r.id AND rt.team_id = p_team_id))
   ORDER BY r.is_default DESC, r.label, r.name;
END
$$;

-- Ownership and grants ------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.bot_runner_teams_guard() OWNER TO manythreads_system;
ALTER FUNCTION app.bot_runners_for_team(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.bot_runner_teams_guard(), app.bot_runners_for_team(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bot_runners_for_team(uuid) TO manythreads_app, manythreads_system;
