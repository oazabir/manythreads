-- channels 0020: pinned messages (PLAN P31-07). Forward-only: never edit once applied.
--
-- A pin keeps a message in its channel's pinned list, the way a notice is pinned to a board. One row per pinned message: who pinned it and when,
-- never the text (the message row holds that, under its own read policy). Whoever can read the channel sees its pins; whoever can post in it pins
-- and unpins, the same set as the bookmarks bar (0010, `app.visible_channel_ids('post')`). The route caps a channel at 100 pins and refuses a deleted
-- message or an archived channel; these policies are the floor under it. The search plugin reads this table for `has:pin` (search 0008), through
-- the same read policy, so a pin never makes a message findable by someone who cannot read it.

CREATE TABLE app.message_pins (
  message_id   uuid PRIMARY KEY REFERENCES app.messages (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  pinned_by    uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  pinned_at    timestamptz NOT NULL DEFAULT now()
);
-- the channel's pinned list, newest pin first
CREATE INDEX message_pins_channel ON app.message_pins (channel_id, pinned_at DESC);
CREATE INDEX message_pins_workspace ON app.message_pins (workspace_id);
CREATE INDEX message_pins_pinned_by ON app.message_pins (pinned_by) WHERE pinned_by IS NOT NULL;
COMMENT ON TABLE app.message_pins IS 'rls: team — C: pinned messages of a channel; readable with the channel (app.visible_channel_ids), pinned and unpinned by whoever can post in it.';

ALTER TABLE app.message_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.message_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY message_pins_select ON app.message_pins FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
-- the message must sit in the channel the pin names (read through the messages table's own policy, so only a message the actor can read)
CREATE POLICY message_pins_insert ON app.message_pins FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (
    workspace_id = (SELECT app.workspace_id()) AND pinned_by = (SELECT app.actor())
    AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])
    AND EXISTS (SELECT 1 FROM app.messages m WHERE m.id = message_id AND m.channel_id = message_pins.channel_id)));
CREATE POLICY message_pins_delete ON app.message_pins FOR DELETE
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]));
GRANT SELECT, INSERT, DELETE ON app.message_pins TO manythreads_app;
