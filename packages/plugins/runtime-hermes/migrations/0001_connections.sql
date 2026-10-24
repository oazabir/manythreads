-- runtime-hermes 0001: Hermes connections and managed-profile credentials. Forward-only: never edit once applied.
--
-- A bot runs as a profile on a Hermes gateway, a program that answers over HTTP. This migration holds the two things the platform keeps for that:
--
--   hermes_connections       one row per gateway a team can place bots on: its address, and its API key as a secret (secret_id, in app.secrets,
--                            so no route and no read ever sees it). A lead (or a workspace admin) of the team writes `external` rows; the platform
--                            writes the team's own pod as the reserved name `managed`. Rows are never deleted by the system, a lead deletes.
--   hermes_profile_secrets   for a bot on the managed gateway, the two credentials the platform generates and must be able to hand to the pod
--                            again: the bot's pairing token (its credential for the stable MCP endpoint) and the key that authorises requests
--                            to the bot's profile. System-only, like every credential table; each value is a secret_id, never a column.
--
-- Ordering: references app.teams and app.bots, so the manifest depends on teams and bots.

-- hermes_connections (T) -----------------------------------------------------------------------------------------------------
CREATE TABLE app.hermes_connections (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  kind            text NOT NULL CHECK (kind IN ('external', 'managed')),
  base_url        text CHECK (base_url IS NULL OR base_url ~ '^https?://'),
  secret_id       uuid REFERENCES app.secrets (id),
  status          text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ok', 'error')),
  last_checked_at timestamptz,
  last_error      text,
  created_by      uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name),
  -- the reserved name and the kind go together, so a lead cannot make an external connection that pretends to be the team's pod
  CONSTRAINT hermes_connections_managed_name CHECK ((kind = 'managed') = (name = 'managed'))
);
CREATE INDEX hermes_connections_workspace ON app.hermes_connections (workspace_id);
CREATE INDEX hermes_connections_secret ON app.hermes_connections (secret_id) WHERE secret_id IS NOT NULL;
CREATE INDEX hermes_connections_created_by ON app.hermes_connections (created_by) WHERE created_by IS NOT NULL;
COMMENT ON TABLE app.hermes_connections IS 'rls: team — T: connections of the teams the caller can read (app.readable_team_ids); a lead or workspace admin writes external ones; the key is secret_id, never a column.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id, secret_id ON app.hermes_connections
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

ALTER TABLE app.hermes_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.hermes_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY hermes_connections_select ON app.hermes_connections FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY hermes_connections_insert ON app.hermes_connections FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (kind = 'external' AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
);
CREATE POLICY hermes_connections_update ON app.hermes_connections FOR UPDATE USING (
  (SELECT app.is_system()) OR (kind = 'external' AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
) WITH CHECK (
  (SELECT app.is_system()) OR (kind = 'external' AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
);
CREATE POLICY hermes_connections_delete ON app.hermes_connections FOR DELETE USING (
  (SELECT app.is_system()) OR (kind = 'external' AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
);
GRANT SELECT, INSERT, UPDATE, DELETE ON app.hermes_connections TO manythreads_app;

-- hermes_profile_secrets (S) -------------------------------------------------------------------------------------------------
CREATE TABLE app.hermes_profile_secrets (
  bot_id                uuid PRIMARY KEY REFERENCES app.bots (id) ON DELETE CASCADE,
  workspace_id          uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id               uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  mcp_token_secret_id   uuid NOT NULL REFERENCES app.secrets (id),
  api_key_secret_id     uuid NOT NULL REFERENCES app.secrets (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  rotated_at            timestamptz
);
CREATE INDEX hermes_profile_secrets_team ON app.hermes_profile_secrets (team_id);
CREATE INDEX hermes_profile_secrets_workspace ON app.hermes_profile_secrets (workspace_id);
CREATE INDEX hermes_profile_secrets_mcp_secret ON app.hermes_profile_secrets (mcp_token_secret_id);
CREATE INDEX hermes_profile_secrets_key_secret ON app.hermes_profile_secrets (api_key_secret_id);
COMMENT ON TABLE app.hermes_profile_secrets IS 'rls: system — S: the generated credentials of a managed bot profile, as secret ids; written and read by the runtime as the system role, no privilege for manythreads_app.';

ALTER TABLE app.hermes_profile_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.hermes_profile_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY hermes_profile_secrets_system ON app.hermes_profile_secrets FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: a credential table the request role never reads
