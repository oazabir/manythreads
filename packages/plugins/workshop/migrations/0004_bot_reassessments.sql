-- workshop 0004: "check this again" notices on a bot (PLAN P7-07). Forward-only: never edit once applied.
--
-- When something a bot depends on changes (a knowledge base it reads is added or removed, a runner it runs on is added, revoked or changed, a connection to another app is added or
-- revoked) or its eval score drops, the bots affected get one notice: what happened and a short list of what to look at again. It is filed by a background subscriber of the platform's
-- own events, as the system role, with a fixed text and NO model call. A lead or an admin of the team reads the open notices on the bot's page (the Workshop's Live mode) and closes
-- each one: `done` (they looked) or `dismissed` (it does not matter). Closing changes nothing else.
--
-- One OPEN notice per bot, reason and subject: a second change of the same kind while one waits is not filed again (the unique index below), so a flapping runner is one line, not fifty.
CREATE TABLE app.bot_reassessments (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  bot_id       uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  reason       text NOT NULL CHECK (reason IN ('knowledge_added', 'knowledge_removed', 'runner_added', 'runner_revoked', 'runner_changed', 'connection_added', 'connection_revoked', 'eval_dropped')),
  subject      text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 100),
  headline     text NOT NULL CHECK (char_length(headline) BETWEEN 1 AND 200),
  checks       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checks) = 'array' AND pg_column_size(checks) <= 4000),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  closed_by    uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  CONSTRAINT bot_reassessments_closed_together CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE UNIQUE INDEX bot_reassessments_one_open ON app.bot_reassessments (bot_id, reason, subject) WHERE status = 'open';
CREATE INDEX bot_reassessments_bot ON app.bot_reassessments (bot_id, created_at DESC);
CREATE INDEX bot_reassessments_team ON app.bot_reassessments (team_id);
CREATE INDEX bot_reassessments_workspace ON app.bot_reassessments (workspace_id);
COMMENT ON TABLE app.bot_reassessments IS 'rls: team — T: notices that something a bot depends on changed (or its eval score dropped) and what to look at again; readers of the team read them, a lead or an admin closes them, only the system role files them (no model is called).';

ALTER TABLE app.bot_reassessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_reassessments FORCE ROW LEVEL SECURITY;
CREATE POLICY bot_reassessments_select ON app.bot_reassessments FOR SELECT
  USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY bot_reassessments_insert ON app.bot_reassessments FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY bot_reassessments_update ON app.bot_reassessments FOR UPDATE
  USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
  WITH CHECK ((SELECT app.is_system()) OR (team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]) AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY bot_reassessments_delete ON app.bot_reassessments FOR DELETE USING ((SELECT app.is_system()));
-- a person may only close a notice: the columns that change are the status and who/when
GRANT SELECT ON app.bot_reassessments TO manythreads_app;
GRANT UPDATE (status, closed_at, closed_by) ON app.bot_reassessments TO manythreads_app;
