-- audit 0001: the audit console's rows (PLAN P10-05). Forward-only: never edit once applied.
--
-- app.audit_events is a content-blind projection of the event log (app.events) and of the memory plugin's retain log: one row per thing that was done,
-- answering who did what, when, to what, and what was held back. It is NOT a second source of truth. Each row's id is the id of the event (or log line)
-- it was made from, so it can be traced back, and writing the same source twice is a no-op. A row holds ids, short names and fixed phrases; the code that
-- writes it never reads a message, a file, a secret or a memory's text (docs/plugins/audit.md).
--
-- Why a table of its own and not a view on app.events: the event log lets every member of a team read that team's events, but the audit console is for
-- workspace admins only, and it also carries facts the log does not (memory the platform held back).
--
-- The table is not partitioned by month: the repo's other append-only tables (events, memory_retain_log) are plain tables with a BRIN index on the time
-- column, and this one follows them. A row is about 300 bytes, so a million rows are a few hundred megabytes.

CREATE TABLE app.audit_events (
  -- the id of the source row (event id or memory_retain_log id): a uuidv7, so ordering by id is ordering by time, and the pagination key
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  occurred_at   timestamptz NOT NULL,
  -- the team the act belongs to, with its name as it was; not a foreign key, so a deleted team's history stays readable
  team_id       uuid,
  team_name     text CHECK (team_name IS NULL OR char_length(team_name) <= 200),
  -- who did it; null when the system acted on its own or the person could not be told. The name is copied for the same reason as team_name.
  actor_id      uuid,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('person', 'bot', 'system')),
  actor_name    text NOT NULL CHECK (char_length(actor_name) <= 200),
  category      text NOT NULL CHECK (category IN ('sign_in', 'people', 'content', 'bots', 'approvals', 'guardrails', 'memory', 'access', 'settings', 'system')),
  action        text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+){1,3}$' AND char_length(action) <= 80),
  target_kind   text CHECK (target_kind IS NULL OR target_kind ~ '^[a-z_]{1,40}$'),
  target_id     text CHECK (target_id IS NULL OR char_length(target_id) BETWEEN 1 AND 80),
  target_label  text CHECK (target_label IS NULL OR char_length(target_label) <= 200),
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'denied', 'failed', 'withheld')),
  -- a short fixed phrase or count, never text a person wrote
  reason        text CHECK (reason IS NULL OR char_length(reason) <= 200),
  source        text NOT NULL CHECK (source IN ('event', 'memory_retain_log')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- the list: newest first within a workspace, then each filter the console offers
CREATE INDEX audit_events_workspace_id ON app.audit_events (workspace_id, id DESC);
CREATE INDEX audit_events_actor ON app.audit_events (workspace_id, actor_id, id DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX audit_events_team ON app.audit_events (workspace_id, team_id, id DESC) WHERE team_id IS NOT NULL;
CREATE INDEX audit_events_action ON app.audit_events (workspace_id, action, id DESC);
CREATE INDEX audit_events_category ON app.audit_events (workspace_id, category, id DESC);
CREATE INDEX audit_events_target ON app.audit_events (workspace_id, target_kind, target_id) WHERE target_id IS NOT NULL;
-- "what was withheld" is the question the console exists for: a small partial index
CREATE INDEX audit_events_outcome ON app.audit_events (workspace_id, id DESC) WHERE outcome <> 'ok';
CREATE INDEX audit_events_occurred_brin ON app.audit_events USING brin (occurred_at);
COMMENT ON TABLE app.audit_events IS 'rls: workspace — W: a content-blind projection of the event log and the memory retain log (who did what, when, to what, with what outcome); read by workspace owners and admins only, written by the system role only, append-only.';

ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_select ON app.audit_events FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY audit_events_insert ON app.audit_events FOR INSERT WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.audit_events TO manythreads_app;
-- Append-only like the event log: a row is never edited or removed by the system role either (the foreign key's CASCADE runs as the table owner).
REVOKE UPDATE, DELETE, TRUNCATE ON app.audit_events FROM manythreads_system;

-- Where the background sweep has got to: the memory log line it last read, and the history backfill's position. System only.
CREATE TABLE app.audit_progress (
  name        text PRIMARY KEY CHECK (name ~ '^[a-z_]{1,60}$'),
  value       text NOT NULL CHECK (char_length(value) <= 200),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.audit_progress IS 'rls: system — S: the audit sweep''s watermarks (memory log position, history backfill position); no privilege for manythreads_app.';
ALTER TABLE app.audit_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_progress_system ON app.audit_progress FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- The key that signs a workspace's exports: the public half is stored here, the private half is a sealed secret (app.secrets). System only; a route
-- hands out the public key and nothing else.
CREATE TABLE app.audit_signing_keys (
  workspace_id    uuid PRIMARY KEY REFERENCES app.workspaces (id) ON DELETE CASCADE,
  key_id          text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  public_key_pem  text NOT NULL CHECK (char_length(public_key_pem) BETWEEN 50 AND 500),
  secret_id       uuid NOT NULL REFERENCES app.secrets (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_signing_keys_secret ON app.audit_signing_keys (secret_id);
COMMENT ON TABLE app.audit_signing_keys IS 'rls: system — S: the public key and sealed private key of a workspace''s audit export signature; no privilege for manythreads_app, only the public key is ever returned by a route.';
ALTER TABLE app.audit_signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_signing_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_signing_keys_system ON app.audit_signing_keys FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
