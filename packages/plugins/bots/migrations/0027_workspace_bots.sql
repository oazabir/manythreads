-- bots 0027 (P20-07): the one Brain of the workspace is a bot that belongs to no team. Forward-only.
--
--  * app.bots.team_id may be NULL for a bot with scope = 'workspace'. A team bot still needs its team (the CHECK below). A workspace bot has no team of its own and
--    is unique by (workspace_id, slug), like a team bot is by (team_id, slug). Rows written before this (a workspace-scoped bot that still names a team) stay valid.
--  * app.bot_runs keeps its required team_id: a run keeps the CONTEXT team (the team of the channel or conversation it answers in), and what it may read comes only
--    from app.run_space_context(). The composite foreign key (bot_id, team_id) cannot hold a bot with no team, so a plain foreign key on bot_id replaces it and a trigger keeps
--    the same promise: a run's team is its bot's team, or, for a workspace bot, any team of the same workspace.
--  * app.message_model_picks (the model a person picked in Chat) names the bot's team in its insert policy; a workspace bot is picked in the context team.
--  * app.workspace_bot_definitions: the BOT.md of a workspace bot, versioned. A team bot's file lives in its team repo; the workspace has no repo, so the text is kept here
--    (written by the system role: the loader at startup, later the proposals flow). The bot row carries the sha of the version in force.
--  * app.workspace_bot_actor_ids(): the roster's lookup of workspace bots' actor ids (a person cannot read the actors table).
--  * app.bots_pairing_mint stays unable to pair a bot with no team (there is no team lead to ask); only the system role could, and nothing does yet.

-- 1 -----------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.bots ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE app.bots ADD CONSTRAINT bots_team_or_workspace CHECK (scope = 'workspace' OR team_id IS NOT NULL);
CREATE UNIQUE INDEX bots_workspace_slug ON app.bots (workspace_id, slug) WHERE scope = 'workspace';
-- A team bot the workspace Brain replaced: switched off (status 'disabled'), kept with all its history, and left out of the roster. Written only by the system role.
ALTER TABLE app.bots ADD COLUMN retired_at timestamptz;
COMMENT ON COLUMN app.bots.retired_at IS 'Set when the workspace Brain replaced this team bot (P20-07). The row, its runs and its conversations stay readable; the roster no longer lists it.';
COMMENT ON COLUMN app.bots.team_id IS 'The team whose repo defines the bot. NULL only for scope = ''workspace'' (the workspace Brain: its definition is app.workspace_bot_definitions).';

-- 2 -----------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.bot_runs DROP CONSTRAINT bot_runs_bot_team_fkey;
ALTER TABLE app.bot_runs ADD CONSTRAINT bot_runs_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES app.bots (id) ON DELETE CASCADE;

CREATE FUNCTION app.bot_runs_check_bot_team() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_scope text;
  v_team  uuid;
  v_ws    uuid;
BEGIN
  SELECT b.scope, b.team_id, b.workspace_id INTO v_scope, v_team, v_ws FROM app.bots b WHERE b.id = NEW.bot_id;
  -- no such bot: the foreign key says so
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v_team IS NOT DISTINCT FROM NEW.team_id THEN RETURN NEW; END IF;
  -- a workspace bot runs in the context team: any team of its own workspace
  IF v_scope = 'workspace' AND v_ws = NEW.workspace_id
     AND EXISTS (SELECT 1 FROM app.teams t WHERE t.id = NEW.team_id AND t.workspace_id = v_ws) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a run belongs to the team of its bot (or, for the workspace bot, to a team of the same workspace)' USING ERRCODE = 'foreign_key_violation';
END
$$;
CREATE TRIGGER bot_runs_check_bot_team BEFORE INSERT OR UPDATE OF bot_id, team_id, workspace_id ON app.bot_runs
  FOR EACH ROW EXECUTE FUNCTION app.bot_runs_check_bot_team();
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.bot_runs_check_bot_team() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.bot_runs_check_bot_team() FROM PUBLIC;

-- 3 -----------------------------------------------------------------------------------------------------------------------
DROP POLICY message_model_picks_insert ON app.message_model_picks;
CREATE POLICY message_model_picks_insert ON app.message_model_picks FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (
    workspace_id = (SELECT app.workspace_id())
    AND asked_by = (SELECT app.actor())
    AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
    AND EXISTS (SELECT 1 FROM app.bots b WHERE b.id = bot_id AND (b.team_id = message_model_picks.team_id OR b.scope = 'workspace'))
    AND EXISTS (SELECT 1 FROM app.messages m WHERE m.id = message_id AND m.author_id = message_model_picks.asked_by)
  )
);

-- 4 -----------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.workspace_bot_definitions (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  slug         text NOT NULL,
  version      integer NOT NULL CHECK (version >= 1),
  sha          text NOT NULL CHECK (sha ~ '^[0-9a-f]{64}$'),
  content      text NOT NULL CHECK (length(content) BETWEEN 1 AND 200000),
  author_id    uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, slug, version),
  CONSTRAINT workspace_bot_definitions_slug CHECK (slug ~ '^[a-z0-9][a-z0-9._-]*$')
);
CREATE INDEX workspace_bot_definitions_sha ON app.workspace_bot_definitions (workspace_id, slug, sha);
COMMENT ON TABLE app.workspace_bot_definitions IS
  'rls: workspace — W: the BOT.md of a workspace bot, one row per version; every non-guest member of the workspace reads it (the bot is workspace-visible), only the system role writes (the loader, the proposals flow). Nothing is ever deleted: an old version stays readable.';

ALTER TABLE app.workspace_bot_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_bot_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_bot_definitions_select ON app.workspace_bot_definitions FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin', 'member')));
CREATE POLICY workspace_bot_definitions_system ON app.workspace_bot_definitions FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.workspace_bot_definitions TO manythreads_app;

-- 5 -----------------------------------------------------------------------------------------------------------------------
-- (bot id, actor id) of the workspace bots of the caller's workspace: names nothing the roster does not already list (a workspace bot is readable by every non-guest member).
CREATE FUNCTION app.workspace_bot_actor_ids()
  RETURNS TABLE (bot_id uuid, actor_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF app.actor() IS NULL OR app.workspace_id() IS NULL OR coalesce(app.lookup_workspace_role(), 'guest') = 'guest' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT b.id, a.id
    FROM app.bots b
    JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id AND a.workspace_id = b.workspace_id
   WHERE b.scope = 'workspace' AND b.workspace_id = app.workspace_id();
END
$$;
REVOKE ALL ON FUNCTION app.workspace_bot_actor_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspace_bot_actor_ids() TO manythreads_app;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.workspace_bot_actor_ids() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

-- 6 -----------------------------------------------------------------------------------------------------------------------
-- A person opens a conversation with the workspace Brain: its context team is the first team (oldest membership) the person belongs to.
-- (conversations_open, conversations 0004, calls this helper.)
CREATE FUNCTION app.workspace_bot_context_team(p_person_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT tm.team_id
    FROM app.team_members tm
    JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' AND a.ref_id = p_person_id
    JOIN app.teams t ON t.id = tm.team_id AND t.archived_at IS NULL AND t.workspace_id = app.workspace_id()
   ORDER BY tm.created_at, tm.team_id
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.workspace_bot_context_team(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspace_bot_context_team(uuid) TO manythreads_app, manythreads_system;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.workspace_bot_context_team(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
