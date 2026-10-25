-- projects 0001: the git repositories a team works on. Forward-only: never edit once applied.
--
-- A project ties one git repository (an https address) to one of the team's channels. Bots asked in that channel are told which repository
-- they work on, and the team's Hermes pod keeps a copy of it. Everyone on the team reads; a team lead or a workspace admin writes, through the
-- plugin's routes (the row-level security policies below say the same, so a direct write by anyone else is refused too).
--
-- Ordering: references app.teams and app.channels, so the manifest depends on teams and channels.

CREATE TABLE app.projects (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  -- also the folder name of the repository on the team's pod, so it follows the same rule as a repository name there
  name           text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,60}$' AND position('..' IN name) = 0),
  -- https only; no user name or password, no query, no fragment, no spaces
  repo_url       text NOT NULL CHECK (repo_url ~ '^https://[^/@?#[:space:]]+(/[^?#[:space:]]*)?$' AND length(repo_url) <= 300),
  default_branch text NOT NULL DEFAULT 'main' CHECK (default_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$' AND position('..' IN default_branch) = 0),
  channel_id     uuid REFERENCES app.channels (id) ON DELETE SET NULL,
  created_by     uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);
CREATE INDEX projects_workspace ON app.projects (workspace_id);
CREATE UNIQUE INDEX projects_channel ON app.projects (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX projects_created_by ON app.projects (created_by) WHERE created_by IS NOT NULL;
COMMENT ON TABLE app.projects IS 'rls: team — T: projects of the teams the caller can read (app.readable_team_ids); a team lead or workspace admin writes them.';

CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id ON app.projects
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- The channel must be an ordinary channel of the project's own team. A definer function, so the check does not depend on which channels the
-- writer can see (the route has already refused a channel the writer cannot see).
CREATE FUNCTION app.projects_channel_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.channel_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.channels c WHERE c.id = NEW.channel_id AND c.team_id = NEW.team_id AND c.kind = 'channel'
  ) THEN
    RAISE EXCEPTION 'a project''s channel must be a channel of the same team' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
ALTER FUNCTION app.projects_channel_guard() OWNER TO manythreads_system;
CREATE TRIGGER projects_channel_guard BEFORE INSERT OR UPDATE OF team_id, channel_id ON app.projects
  FOR EACH ROW EXECUTE FUNCTION app.projects_channel_guard();

ALTER TABLE app.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_select ON app.projects FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY projects_insert ON app.projects FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
);
CREATE POLICY projects_update ON app.projects FOR UPDATE USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
) WITH CHECK (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
);
CREATE POLICY projects_delete ON app.projects FOR DELETE USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
);
GRANT SELECT, INSERT, UPDATE, DELETE ON app.projects TO manythreads_app;
