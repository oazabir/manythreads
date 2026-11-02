-- connections 0002: a person's own connections to outside accounts (Google, Microsoft, Notion), held by manythreads (PLAN P8-02). Forward-only: never edit once applied.
--
-- A person connection is a row of app.connections with scope = 'person' (0001 already allows it: the owner sees and changes it, nobody else does). What this adds:
--
--   connection_oauth_flows    one row per sign-in to a provider that was started and not yet finished (the one-time state, the PKCE proof, where to send the person
--                             back to). System only; a row lives ten minutes and is deleted by the callback that uses it.
--   connection_oauth          what the platform knows about a person connection that is not a secret: which provider, which scopes the person agreed to, whose account it
--                             is (a label for the screen), when the access token stops working and whether the person has to sign in again. The tokens themselves are
--                             sealed rows of connection_secrets, as for every other connection.
--   person_connection_grants  which bot may use which tool of the PERSON who asked it (BOT.md `capabilities.connections` entry `person:*`). Unlike connection_grants it
--                             names no connection: the connection is looked up at call time among the asker's own, so a bot can never reach anyone else's.

-- connection_oauth_flows (S) -----------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.connection_oauth_flows (
  state_hash    bytea PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- the person who started it: the callback must come from the same signed-in person
  owner_id      uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- the services (drive, gmail, ...) the person was asked about; their scopes are what was requested
  services      text[] NOT NULL CHECK (cardinality(services) BETWEEN 1 AND 16),
  -- PKCE proof; null for a provider that has no PKCE (Notion)
  code_verifier text CHECK (code_verifier IS NULL OR char_length(code_verifier) BETWEEN 43 AND 128),
  -- a path of this site to send the browser back to
  return_to     text NOT NULL CHECK (char_length(return_to) <= 500 AND return_to LIKE '/%' AND return_to NOT LIKE '//%'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX connection_oauth_flows_expiry ON app.connection_oauth_flows (expires_at);
CREATE INDEX connection_oauth_flows_workspace ON app.connection_oauth_flows (workspace_id);
CREATE INDEX connection_oauth_flows_owner ON app.connection_oauth_flows (owner_id);
COMMENT ON TABLE app.connection_oauth_flows IS 'rls: system — S: unfinished provider sign-ins (single-use state, PKCE proof); no privilege for manythreads_app.';

-- connection_oauth (T) ------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.connection_oauth (
  connection_id     uuid PRIMARY KEY REFERENCES app.connections (id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- what the provider says the person agreed to (the union over every sign-in: scopes are added, never silently dropped)
  scopes            text[] NOT NULL DEFAULT '{}',
  -- who the account is (an address or a workspace name), for the screen; never a token
  account_label     text CHECK (account_label IS NULL OR char_length(account_label) <= 200),
  -- when the access token stops working; null = the provider says it does not (Notion)
  access_expires_at timestamptz,
  -- `ok`, or `needs_reconnect` once the provider refused the stored refresh token: the person must sign in again
  state             text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'needs_reconnect')),
  refreshed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connection_oauth_workspace ON app.connection_oauth (workspace_id);
COMMENT ON TABLE app.connection_oauth IS 'rls: person — T: readable by whoever can read the connection row (its owner); written by the system only. No token is stored here (those are sealed connection_secrets).';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id ON app.connection_oauth
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- person_connection_grants (T) ----------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.person_connection_grants (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  -- the bot's actor
  actor_id       uuid NOT NULL,
  -- one exact tool, `namespace.verb`
  tool           text NOT NULL CHECK (tool ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  -- informational, as in connection_grants: the gate is capability_grants.needs_approval
  needs_approval boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (team_id, actor_id) REFERENCES app.team_members (team_id, actor_id) ON DELETE CASCADE,
  UNIQUE (actor_id, tool)
);
CREATE INDEX person_connection_grants_team ON app.person_connection_grants (team_id);
CREATE INDEX person_connection_grants_workspace ON app.person_connection_grants (workspace_id);
COMMENT ON TABLE app.person_connection_grants IS 'rls: team — T: readable by the people of the team (never a guest); written by the system only (the connections plugin compiles it from the bots'' BOT.md files).';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id ON app.person_connection_grants
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- Row level security ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.connection_oauth_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_oauth_flows FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_oauth_flows_system ON app.connection_oauth_flows FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app

ALTER TABLE app.connection_oauth ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_oauth FORCE ROW LEVEL SECURITY;
-- whoever can read the connection can read what is known about it (a person connection: its owner). The inner select runs under the connections policy.
CREATE POLICY connection_oauth_select ON app.connection_oauth FOR SELECT USING (
  (SELECT app.is_system()) OR EXISTS (SELECT 1 FROM app.connections c WHERE c.id = connection_oauth.connection_id)
);
CREATE POLICY connection_oauth_insert ON app.connection_oauth FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY connection_oauth_update ON app.connection_oauth FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY connection_oauth_delete ON app.connection_oauth FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.connection_oauth TO manythreads_app;

ALTER TABLE app.person_connection_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.person_connection_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY person_connection_grants_select ON app.person_connection_grants FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY person_connection_grants_insert ON app.person_connection_grants FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY person_connection_grants_update ON app.person_connection_grants FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY person_connection_grants_delete ON app.person_connection_grants FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.person_connection_grants TO manythreads_app;
