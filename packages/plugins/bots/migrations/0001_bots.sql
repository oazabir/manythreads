-- bots plugin 0001: bot identity, credentials, runs and what a run read (PLAN.md A.5, P5-03). Forward-only: never edit once applied.
--
--  * bots: one row per `bots/<slug>/BOT.md` of a team's repo, rebuilt by the loader (P5-04) whenever that file
--    changes. `definition_sha` is the sha256 it was rebuilt from and `status = 'invalid'` keeps the row of the
--    last good definition, so a typo in BOT.md does not delete the bot. Runs and pairing tokens cascade with it.
--  * bot_pairing_tokens: the sha256 of a live pairing token and nothing else — like app.session_tokens it keeps no
--    privilege for manythreads_app; the gateway validates it as the system role.
--  * bot_runs: one run. `trigger_type` is the BOT.md trigger that fired it, `asker_id` who asked (null for a
--    scheduled or inbound run), `thread_id` the thread it answers in.
--  * run_source_log: what a run read (source type, ref, scope) — the evidence behind an answer's "Sources reached"
--    (PLAN P5-18). A run writes its own lines through `app.run_id()`; nothing else may.
--
-- Ordering: the manifest's `dependsOn: ['channels']` puts this namespace after channels, because bot_runs
-- references app.threads (key: root_message_id).

-- bots (T) ----------------------------------------------------------------------------------------------------------------
CREATE TABLE app.bots (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  slug           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('agent', 'automation')),
  runtime        text NOT NULL CHECK (runtime IN ('hermes', 'rules')),
  visibility     text NOT NULL CHECK (visibility IN ('team', 'workspace')),
  definition_sha text NOT NULL,
  status         text NOT NULL CHECK (status IN ('active', 'disabled', 'invalid')),
  placement      jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- the BOT.md frontmatter's own shapes (SPEC §7.1), enforced where the data lands
  CONSTRAINT bots_slug CHECK (slug ~ '^[a-z0-9][a-z0-9._-]*$'),
  CONSTRAINT bots_definition_sha CHECK (definition_sha ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX bots_team_slug ON app.bots (team_id, slug);
CREATE INDEX bots_team ON app.bots (team_id);
COMMENT ON TABLE app.bots IS 'rls: team — T: bots of the teams the caller can read (app.readable_team_ids); a workspace-visible bot is readable by every non-guest member of the workspace; writes are the system loader (P5-04).';

-- bot_pairing_tokens (S) ------------------------------------------------------------------------------------------------
CREATE TABLE app.bot_pairing_tokens (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  bot_id     uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX bot_pairing_tokens_live ON app.bot_pairing_tokens (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX bot_pairing_tokens_bot ON app.bot_pairing_tokens (bot_id);
COMMENT ON TABLE app.bot_pairing_tokens IS 'rls: system — S: sha256 of a live bot pairing token (never the token itself); no privilege for manythreads_app, the gateway resolves it as the system role.';

-- bot_runs (T; asker own) ------------------------------------------------------------------------------------------------
CREATE TABLE app.bot_runs (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  bot_id       uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  trigger_type text NOT NULL CHECK (trigger_type IN ('conversation', 'mention', 'routine', 'task_assigned', 'inbox', 'channel_message', 'webhook')),
  asker_id     uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  -- a thread row's key is its root message id (channels 0002), which is what `ThreadId` names
  thread_id    uuid REFERENCES app.threads (root_message_id) ON DELETE SET NULL,
  status       text NOT NULL CHECK (status IN ('running', 'done', 'failed', 'stopped')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  CONSTRAINT bot_runs_ended_after_started CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX bot_runs_bot_id_desc ON app.bot_runs (bot_id, id DESC);
CREATE INDEX bot_runs_live ON app.bot_runs (bot_id) WHERE ended_at IS NULL;
CREATE INDEX bot_runs_team_id_desc ON app.bot_runs (team_id, id DESC);
CREATE INDEX bot_runs_thread ON app.bot_runs (thread_id) WHERE thread_id IS NOT NULL;
COMMENT ON TABLE app.bot_runs IS 'rls: team — T: runs of the teams the caller can read (app.readable_team_ids); the asker reads their own runs and may start one in a team they can read; status changes are the runtime (system).';

-- run_source_log (T) ----------------------------------------------------------------------------------------------------
CREATE TABLE app.run_source_log (
  run_id      uuid NOT NULL REFERENCES app.bot_runs (id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  source_type text NOT NULL,
  source_ref  text NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('team', 'channel', 'person')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq),
  CONSTRAINT run_source_log_seq_nonnegative CHECK (seq >= 0)
);
COMMENT ON TABLE app.run_source_log IS 'rls: team — T: readable with the run''s team; a run writes its own lines through app.run_id(), every other writer is the system role. `source_type` is an open set (message, page, file, memory, ...) that plugins extend.';

-- Row level security ----------------------------------------------------------------------------------------------------
ALTER TABLE app.bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bots FORCE ROW LEVEL SECURITY;
CREATE POLICY bots_select ON app.bots FOR SELECT USING (
  (SELECT app.is_system())
  OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
  OR (visibility = 'workspace' AND workspace_id = (SELECT app.workspace_id())
      AND (SELECT app.workspace_role()) IN ('owner', 'admin', 'member')));
CREATE POLICY bots_system ON app.bots FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.bots TO manythreads_app;

ALTER TABLE app.bot_pairing_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_pairing_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY bot_pairing_tokens_system ON app.bot_pairing_tokens FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: a credential table the request role never reads (like app.session_tokens)

ALTER TABLE app.bot_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY bot_runs_select ON app.bot_runs FOR SELECT USING (
  (SELECT app.is_system())
  OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
  OR (asker_id IS NOT NULL AND asker_id = (SELECT app.actor())));
CREATE POLICY bot_runs_insert ON app.bot_runs FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id())
      AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
      AND asker_id = (SELECT app.actor())));
CREATE POLICY bot_runs_update ON app.bot_runs FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT, INSERT ON app.bot_runs TO manythreads_app;

ALTER TABLE app.run_source_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_source_log FORCE ROW LEVEL SECURITY;
CREATE POLICY run_source_log_select ON app.run_source_log FOR SELECT USING (
  (SELECT app.is_system())
  OR run_id IN (SELECT r.id FROM app.bot_runs r WHERE r.team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])));
CREATE POLICY run_source_log_insert ON app.run_source_log FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR run_id = (SELECT app.run_id()));
GRANT SELECT, INSERT ON app.run_source_log TO manythreads_app;

GRANT CREATE ON SCHEMA app TO manythreads_system;
