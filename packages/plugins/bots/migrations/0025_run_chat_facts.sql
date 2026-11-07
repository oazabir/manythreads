-- bots 0025: what a conversation run knows about its turn, and the model a person picked for a message (PLAN P20-16). Forward-only: never edit once applied.
--
-- The Chat screen shows several answers to one message (Regenerate keeps the earlier ones) and says which model answered. Three pieces, all here because the bots
-- plugin owns runs:
--
--   * `bot_runs.turn_message_id`: the person's message the run answers. The run job writes it as the system role right after the run opens, so the conversations
--     plugin can tell which turn a reply belongs to from the reply's own `meta.runId`. A pointer to a message that is later hard-deleted becomes null.
--   * `bot_runs.model_alias`: the alias the run used (the definition's first alias, or the one the person picked for this message). Written with the turn.
--   * `bot_runs.stopped_by_asker`: the asker pressed Stop; the reply is what had been written by then. Written before that reply is posted.
--   * `message_model_picks`: the alias a person picked for one message. The conversations send route files it in the transaction that posts the message (the way the
--     Test action files `rehearsal_questions`), and the router (runtime-hermes) reads it when the message's event arrives. The row is the asker's alone.
--     The route checks the alias against the bot's own list before it files the row; the run job checks it again, so a forged row could not make a run use a model
--     the definition does not name.

ALTER TABLE app.bot_runs ADD COLUMN turn_message_id uuid REFERENCES app.messages (id) ON DELETE SET NULL;
ALTER TABLE app.bot_runs ADD COLUMN model_alias text CHECK (model_alias IS NULL OR char_length(model_alias) BETWEEN 1 AND 40);
ALTER TABLE app.bot_runs ADD COLUMN stopped_by_asker boolean NOT NULL DEFAULT false;
CREATE INDEX bot_runs_turn_message ON app.bot_runs (turn_message_id) WHERE turn_message_id IS NOT NULL;

-- message_model_picks (T; asker own) --------------------------------------------------------------------------------------
CREATE TABLE app.message_model_picks (
  message_id   uuid PRIMARY KEY REFERENCES app.messages (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  bot_id       uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  asked_by     uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  model_alias  text NOT NULL CHECK (char_length(model_alias) BETWEEN 1 AND 40),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_model_picks_workspace ON app.message_model_picks (workspace_id);
CREATE INDEX message_model_picks_team ON app.message_model_picks (team_id);
CREATE INDEX message_model_picks_bot ON app.message_model_picks (bot_id);
CREATE INDEX message_model_picks_asked_by ON app.message_model_picks (asked_by);
COMMENT ON TABLE app.message_model_picks IS 'rls: person — P: the model alias a person picked for one message of their conversation with a bot; the asker files and reads their own (the message must be theirs, the bot one of a team they can read), the router reads all as the system role.';

ALTER TABLE app.message_model_picks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.message_model_picks FORCE ROW LEVEL SECURITY;
CREATE POLICY message_model_picks_select ON app.message_model_picks FOR SELECT USING (
  (SELECT app.is_system())
  OR asked_by = (SELECT app.actor())
);
CREATE POLICY message_model_picks_insert ON app.message_model_picks FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (
    workspace_id = (SELECT app.workspace_id())
    AND asked_by = (SELECT app.actor())
    AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
    AND EXISTS (SELECT 1 FROM app.bots b WHERE b.id = bot_id AND b.team_id = message_model_picks.team_id)
    AND EXISTS (SELECT 1 FROM app.messages m WHERE m.id = message_id AND m.author_id = message_model_picks.asked_by)
  )
);
CREATE POLICY message_model_picks_system ON app.message_model_picks FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT, INSERT ON app.message_model_picks TO manythreads_app;
