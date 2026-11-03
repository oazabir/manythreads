-- memory-inbox 0002: the email door and action items on the board (PLAN P8-19, P8-20). Forward-only: never edit once applied.
--
--  * memory_inbox_mail:    one row per message the email door accepted for a team, keyed by the message's own Message-ID. The same message delivered twice (a
--                          retry of the transport, or a copy through two addresses of the same team) is one item. System role only: it is the door's bookkeeping.
--                          `connection_id` names the workspace mailbox it came in on; it has no foreign key because the connections plugin is not part of every
--                          schema this plugin is tested against.
--  * memory_inbox_actions: the card an action item became. An `Action Items` concept lists actions; a person adds one to the board from the Inbox tab (the web
--                          makes the card through the tasks API as that person) and the inbox records which action it was, so the screen shows "on the board"
--                          and nobody adds the same action twice. `task_id` has no foreign key for the same reason as above.

-- memory_inbox_mail (S) ------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.memory_inbox_mail (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  connection_id uuid        NOT NULL,
  message_id    text        NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 300),
  item_id       uuid        REFERENCES app.memory_inbox_items (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, message_id)
);
CREATE INDEX memory_inbox_mail_workspace ON app.memory_inbox_mail (workspace_id);
CREATE INDEX memory_inbox_mail_item ON app.memory_inbox_mail (item_id) WHERE item_id IS NOT NULL;
COMMENT ON TABLE app.memory_inbox_mail IS 'rls: system — S: the messages the email door accepted, by Message-ID, so one message is one item; no privilege for manythreads_app.';
ALTER TABLE app.memory_inbox_mail ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_inbox_mail FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_inbox_mail_system ON app.memory_inbox_mail FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app

-- memory_inbox_actions (T) ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.memory_inbox_actions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  item_id      uuid        NOT NULL REFERENCES app.memory_inbox_items (id) ON DELETE CASCADE,
  -- which concept of the item, and which action in it (0-based, in the order the lines are written)
  concept_path text        NOT NULL CHECK (char_length(concept_path) BETWEEN 1 AND 500),
  action_index integer     NOT NULL CHECK (action_index BETWEEN 0 AND 1000),
  task_id      uuid        NOT NULL,
  -- the person who made the card; never a bot
  added_by     uuid        NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, concept_path, action_index)
);
CREATE INDEX memory_inbox_actions_team ON app.memory_inbox_actions (team_id);
CREATE INDEX memory_inbox_actions_workspace ON app.memory_inbox_actions (workspace_id);
CREATE INDEX memory_inbox_actions_added_by ON app.memory_inbox_actions (added_by);
CREATE INDEX memory_inbox_actions_task ON app.memory_inbox_actions (task_id);
COMMENT ON TABLE app.memory_inbox_actions IS 'rls: team — T: readable by the people of the team (not a guest); a person with post rights on the team records the card they made, as themselves; changed or removed by the system only.';
ALTER TABLE app.memory_inbox_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_inbox_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_inbox_actions_select ON app.memory_inbox_actions FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY memory_inbox_actions_insert ON app.memory_inbox_actions FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) AND added_by = (SELECT app.actor()))
);
CREATE POLICY memory_inbox_actions_update ON app.memory_inbox_actions FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY memory_inbox_actions_delete ON app.memory_inbox_actions FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT ON app.memory_inbox_actions TO manythreads_app;
