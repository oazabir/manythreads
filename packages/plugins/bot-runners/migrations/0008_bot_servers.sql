-- bot-runners 0008: enrolled servers (PLAN.md Phase 26, P26-12 and P26-13; docs/plans/agents-anywhere.md §5). Forward-only and additive: a server one version back never
-- reads the new table or the new column, and its inserts take the default.
--
--   bot_servers          one machine outside the cluster where the installer put the agent bridge. The bridge dials out and keeps one WebSocket open to the site; the
--                        site's requests to the bridge travel inside it. Owned by the workspace; workspace admins read and write, and the system role (the enrolment and
--                        connect routes, which have no signed-in person) too.
--     enrol_code_hash    SHA-256 (hex) of the one-time code the installer redeems; null once used. The code itself is never stored.
--     key_hash           SHA-256 (hex) of the bridge key (`mtb_` + 256 random bits), compared at every connect and every heartbeat. The key itself is never stored.
--     pending_key_hash   the hash of a new key while a rotation is in flight (the old key still opens until the bridge has answered `rotated`).
--     agents             what the bridge found on the machine: [{ "agent": "claude-code" | "codex" | "hermes-acp", "version": "..." }].
--   bot_runners.server_id  the server a `server_agent` runner is one agent of (0007 added the kind). A server runner has one, every other kind has none.
--
-- The runners of a server are made and kept in step by the site when the server enrols or connects (one per agent found); they are rows of the catalog like any other
-- (an admin shares them with teams there), and they go with the server.

CREATE TABLE app.bot_servers (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id       uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- never changes; each agent found becomes a runner called <name>-claude, <name>-codex or <name>-hermes
  name               text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  label              text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 80),
  status             text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'connected', 'offline')),
  enrol_code_hash    text CHECK (enrol_code_hash IS NULL OR enrol_code_hash ~ '^[0-9a-f]{64}$'),
  enrol_code_expires_at timestamptz,
  key_hash           text CHECK (key_hash IS NULL OR key_hash ~ '^[0-9a-f]{64}$'),
  pending_key_hash   text CHECK (pending_key_hash IS NULL OR pending_key_hash ~ '^[0-9a-f]{64}$'),
  host_name          text CHECK (host_name IS NULL OR char_length(host_name) <= 120),
  host_system        text CHECK (host_system IS NULL OR char_length(host_system) <= 120),
  host_arch          text CHECK (host_arch IS NULL OR char_length(host_arch) <= 40),
  bridge_version     text CHECK (bridge_version IS NULL OR char_length(bridge_version) <= 40),
  agents             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(agents) = 'array'),
  allow_full_access  boolean NOT NULL DEFAULT false,
  created_by         uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  last_seen_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE UNIQUE INDEX bot_servers_key_hash ON app.bot_servers (key_hash) WHERE key_hash IS NOT NULL;
CREATE UNIQUE INDEX bot_servers_pending_key_hash ON app.bot_servers (pending_key_hash) WHERE pending_key_hash IS NOT NULL;
CREATE UNIQUE INDEX bot_servers_enrol_code_hash ON app.bot_servers (enrol_code_hash) WHERE enrol_code_hash IS NOT NULL;
CREATE INDEX bot_servers_created_by ON app.bot_servers (created_by) WHERE created_by IS NOT NULL;
COMMENT ON TABLE app.bot_servers IS 'rls: workspace — W: workspace admins read and write, and the system role (enrolment and connect have no signed-in person); a key and a one-time code are kept as SHA-256 hashes only, never as a column of their own.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id ON app.bot_servers
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

ALTER TABLE app.bot_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_servers FORCE ROW LEVEL SECURITY;
CREATE POLICY bot_servers_admin ON app.bot_servers FOR ALL
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.bot_servers TO manythreads_app;

ALTER TABLE app.bot_runners
  ADD COLUMN server_id uuid REFERENCES app.bot_servers (id) ON DELETE CASCADE,
  ADD CONSTRAINT bot_runners_server_id_kind CHECK ((kind = 'server_agent') = (server_id IS NOT NULL));
CREATE INDEX bot_runners_server ON app.bot_runners (server_id) WHERE server_id IS NOT NULL;
COMMENT ON COLUMN app.bot_runners.server_id IS 'The enrolled server (app.bot_servers) this server_agent runner is one agent of; null for every other kind. The runner goes with the server.';
