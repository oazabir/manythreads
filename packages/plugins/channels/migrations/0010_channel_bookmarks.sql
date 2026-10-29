-- channels 0010: the bookmarks bar of a channel (PLAN P14-12). Forward-only: never edit once applied.
--
-- A bookmark is a link, a file or a page that a channel keeps in a bar under its header, so people find it without scrolling. It holds only a
-- reference (`target`: the address of a link, the id of a file, or the path of a page in the team's repository) and a short title. Whoever
-- can read the channel sees its bookmarks; whoever can post in it adds and removes them (the same set as `app.visible_channel_ids('post')`).
-- A page's or file's own permissions still decide whether opening it works: a bookmark never carries content.

CREATE TABLE app.channel_bookmarks (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('link', 'file', 'page')),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  target       text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 2000),
  created_by   uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_bookmarks_channel ON app.channel_bookmarks (channel_id, id);
CREATE INDEX channel_bookmarks_workspace ON app.channel_bookmarks (workspace_id);
CREATE INDEX channel_bookmarks_created_by ON app.channel_bookmarks (created_by) WHERE created_by IS NOT NULL;
-- the same thing twice in one channel is one bookmark
CREATE UNIQUE INDEX channel_bookmarks_target ON app.channel_bookmarks (channel_id, kind, target);
COMMENT ON TABLE app.channel_bookmarks IS 'rls: team — C: links, files and pages kept in a channel''s bookmarks bar; readable with the channel (app.visible_channel_ids), added and removed by whoever can post in it.';

ALTER TABLE app.channel_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_bookmarks FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_bookmarks_select ON app.channel_bookmarks FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY channel_bookmarks_insert ON app.channel_bookmarks FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (
    workspace_id = (SELECT app.workspace_id()) AND created_by = (SELECT app.actor())
    AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])));
CREATE POLICY channel_bookmarks_delete ON app.channel_bookmarks FOR DELETE
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]));
GRANT SELECT, INSERT, DELETE ON app.channel_bookmarks TO manythreads_app;
