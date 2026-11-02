-- connections 0001: connections to outside services, what a bot may use of them, and where their credentials live (PLAN P8-01). Forward-only: never edit once applied.
--
-- A connection is a named link to one outside service (a mailbox, a drive, a ticket system) that people set up once and bots then use through tools.
--
--   connections         one row per connection: whose it is (scope team / person / workspace, and the owner), what it is for (kind, environment), whether it is switched
--                       on, when its credential stops working (expires_at). No credential is a column: has_credentials only says that one is stored.
--   connection_grants   which bot may call which tool through which team connection (a tool allowlist per bot; needs_approval makes the call wait for a person).
--                       Compiled from a bot's BOT.md `capabilities.connections` by the connections plugin; people never write it by hand.
--   connection_secrets  the credentials of a connection: each one a reference to an envelope-encrypted row of app.secrets (the platform's own sealing, nothing new).
--                       System role only. The application role has no privilege on it at all, so no route or query as a person can read, list or count it.
--
-- Ordering: references app.workspaces, app.teams, app.actors, app.team_members and app.secrets (kernel and teams), so the manifest depends on teams.

-- connections (T) ------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.connections (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- the team of a team connection; null for a person or workspace connection
  team_id         uuid REFERENCES app.teams (id) ON DELETE CASCADE,
  -- the short name a BOT.md `capabilities.connections[].connection` uses; it never changes
  slug            text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  -- what kind of service it is (`email`); the kinds the platform knows live in code, not here
  kind            text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  name            text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 80),
  scope           text NOT NULL CHECK (scope IN ('team', 'person', 'workspace')),
  -- who set it up and answers for it; for a person connection, whose it is. Their removal removes the connection (and, by the system, its credentials).
  owner_id        uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  -- a new connection is off until someone switches it on
  status          text NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled', 'disabled')),
  environment     text NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'staging', 'development', 'test')),
  -- when the credential stops working; null = no known end. An expired connection is treated as off.
  expires_at      timestamptz,
  -- true while at least one credential is stored (kept by a trigger on connection_secrets; nobody else can set it)
  has_credentials boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connections_team_scope CHECK ((scope = 'team') = (team_id IS NOT NULL)),
  -- the target of the grants' composite key: a grant can only name a connection of its own team
  CONSTRAINT connections_id_team UNIQUE (id, team_id)
);
CREATE UNIQUE INDEX connections_team_slug ON app.connections (team_id, slug) WHERE scope = 'team';
CREATE UNIQUE INDEX connections_workspace_slug ON app.connections (workspace_id, slug) WHERE scope = 'workspace';
CREATE UNIQUE INDEX connections_person_slug ON app.connections (workspace_id, owner_id, slug) WHERE scope = 'person';
CREATE INDEX connections_workspace ON app.connections (workspace_id);
CREATE INDEX connections_owner ON app.connections (owner_id);
COMMENT ON TABLE app.connections IS 'rls: team — T: a team connection is readable by the people (and bots) of its team, never a guest; a workspace connection by workspace admins; a person connection by its owner alone. Written by workspace admins (team and workspace scope) or the owner (person scope) and the system; deleted by the system only (it removes the credentials first). No credential is a column.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id ON app.connections
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- connection_grants (T) -----------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.connection_grants (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL,
  -- the team of the connection AND of the bot: only a team connection can be granted, and only to a bot that is a member of that same team
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  -- the bot's actor
  actor_id       uuid NOT NULL,
  -- one exact tool, `namespace.verb`: no wildcard is ever granted from a connection
  tool           text NOT NULL CHECK (tool ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  -- informational only: the gate that makes a call wait for a person is capability_grants.needs_approval (the broker's), which the compile writes beside this row
  needs_approval boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, team_id) REFERENCES app.connections (id, team_id) ON DELETE CASCADE,
  -- a bot that leaves the team (or is removed) loses its grants with it
  FOREIGN KEY (team_id, actor_id) REFERENCES app.team_members (team_id, actor_id) ON DELETE CASCADE,
  -- one connection per tool per bot: the same tool through two connections would be two grants for one capability, which the broker cannot tell apart
  UNIQUE (actor_id, tool)
);
CREATE INDEX connection_grants_connection ON app.connection_grants (connection_id);
CREATE INDEX connection_grants_team ON app.connection_grants (team_id);
CREATE INDEX connection_grants_workspace ON app.connection_grants (workspace_id);
COMMENT ON TABLE app.connection_grants IS 'rls: team — T: readable by the people of the team (never a guest); written by the system only (the connections plugin compiles it from the bots'' BOT.md files).';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id ON app.connection_grants
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- connection_secrets (S) ----------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.connection_secrets (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES app.connections (id) ON DELETE CASCADE,
  -- what the credential is called inside its kind (`password`, `access_token`)
  name          text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- the sealed value; the plaintext is never stored here and never read back by a route
  secret_id     uuid NOT NULL REFERENCES app.secrets (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, name)
);
CREATE INDEX connection_secrets_workspace ON app.connection_secrets (workspace_id);
CREATE INDEX connection_secrets_secret ON app.connection_secrets (secret_id);
COMMENT ON TABLE app.connection_secrets IS 'rls: system — S: references to the sealed credentials of a connection (app.secrets); no privilege for manythreads_app, never returned by any API.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, secret_id ON app.connection_secrets
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- Guards ---------------------------------------------------------------------------------------------------------------------------------------------
-- What the foreign keys cannot say: the owner is an actor of the connection's workspace (a person for a person connection), what a connection IS never changes
-- under a person (workspace, team, scope, owner, kind, slug), and nobody but the system can claim that credentials are stored. SECURITY DEFINER so it can read
-- app.actors, which the application role cannot.
CREATE FUNCTION app.connections_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_owner_ws   uuid;
  v_owner_kind text;
BEGIN
  SELECT a.workspace_id, a.kind INTO v_owner_ws, v_owner_kind FROM app.actors a WHERE a.id = NEW.owner_id;
  IF v_owner_ws IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'connections.owner_id must be an actor of the row''s workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.scope = 'person' AND v_owner_kind IS DISTINCT FROM 'person' THEN
    RAISE EXCEPTION 'a person connection is owned by a person' USING ERRCODE = 'check_violation';
  END IF;
  -- not app.is_system(): inside this definer function that is always true (it reads current_user); the login that opened the session is what says who is asking
  IF session_user = 'manythreads_system' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.has_credentials THEN
      RAISE EXCEPTION 'has_credentials is kept by the platform' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.has_credentials IS DISTINCT FROM OLD.has_credentials THEN
    RAISE EXCEPTION 'a connection''s workspace, team, scope, owner, kind and short name cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER connections_guard BEFORE INSERT OR UPDATE ON app.connections
  FOR EACH ROW EXECUTE FUNCTION app.connections_guard();

-- has_credentials follows the credential rows. Only the system role writes connection_secrets, so this runs as the system role and RLS lets it through.
CREATE FUNCTION app.connection_secrets_flag() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.connection_id ELSE NEW.connection_id END;
BEGIN
  UPDATE app.connections c SET has_credentials = EXISTS (SELECT 1 FROM app.connection_secrets s WHERE s.connection_id = c.id) WHERE c.id = v_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER connection_secrets_flag AFTER INSERT OR DELETE ON app.connection_secrets
  FOR EACH ROW EXECUTE FUNCTION app.connection_secrets_flag();

-- A credential row that goes (deleted by the plugin, or cascaded away with its connection, team, owner or workspace) takes its sealed value with it: without this
-- a cascade would leave the ciphertext in app.secrets with nothing pointing at it. AFTER DELETE, so the reference is already gone when the sealed row is removed.
-- SECURITY DEFINER (owned by the system role, which may delete from app.secrets) so it also runs when the cascade was started by a person's session; the
-- search_path is pinned; the row is kept when another credential row still points at it.
CREATE FUNCTION app.connection_secrets_reap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  DELETE FROM app.secrets s WHERE s.id = OLD.secret_id AND NOT EXISTS (SELECT 1 FROM app.connection_secrets o WHERE o.secret_id = OLD.secret_id);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.connection_secrets_reap() FROM PUBLIC;
CREATE TRIGGER connection_secrets_reap AFTER DELETE ON app.connection_secrets
  FOR EACH ROW EXECUTE FUNCTION app.connection_secrets_reap();

-- Row level security ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connections FORCE ROW LEVEL SECURITY;
-- read: a team connection by the people of its team (the hoisted set: built once per statement); a workspace connection by workspace admins; a person connection by its owner
CREATE POLICY connections_select ON app.connections FOR SELECT USING (
  (SELECT app.is_system())
  OR (scope = 'team' AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))
  OR (scope = 'workspace' AND workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin'))
  OR (scope = 'person' AND workspace_id = (SELECT app.workspace_id()) AND owner_id = (SELECT app.actor()))
);
-- write: a workspace admin sets up a team or workspace connection; a person sets up their own
CREATE POLICY connections_insert ON app.connections FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id())
      AND ((scope IN ('team', 'workspace') AND (SELECT app.workspace_role()) IN ('owner', 'admin'))
           OR (scope = 'person' AND owner_id = (SELECT app.actor()))))
);
CREATE POLICY connections_update ON app.connections FOR UPDATE USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id())
      AND ((scope IN ('team', 'workspace') AND (SELECT app.workspace_role()) IN ('owner', 'admin'))
           OR (scope = 'person' AND owner_id = (SELECT app.actor()))))
) WITH CHECK (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id())
      AND ((scope IN ('team', 'workspace') AND (SELECT app.workspace_role()) IN ('owner', 'admin'))
           OR (scope = 'person' AND owner_id = (SELECT app.actor()))))
);
-- delete: the system only, so the credentials are removed first (a stored secret would otherwise outlive its connection)
CREATE POLICY connections_delete ON app.connections FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.connections TO manythreads_app;

ALTER TABLE app.connection_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_grants_select ON app.connection_grants FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY connection_grants_insert ON app.connection_grants FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY connection_grants_update ON app.connection_grants FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY connection_grants_delete ON app.connection_grants FOR DELETE USING ((SELECT app.is_system()));
-- the application role may read it; the compile writes it as the system role
GRANT SELECT ON app.connection_grants TO manythreads_app;

ALTER TABLE app.connection_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_secrets_system ON app.connection_secrets FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: a person's session cannot even name the table

-- Owned by the system role like every other definer function (a login that can set up the schema would otherwise be the one whose rights these run with).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.connections_guard() OWNER TO manythreads_system;
ALTER FUNCTION app.connection_secrets_flag() OWNER TO manythreads_system;
ALTER FUNCTION app.connection_secrets_reap() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
