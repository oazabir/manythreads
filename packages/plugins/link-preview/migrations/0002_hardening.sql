-- link-preview 0002: hardening after the security review (PLAN P14-08). Forward-only: never edit once applied.
--
--   1. a stored picture is at most 512 KiB (was 2 MiB): a card shows it at 88 pixels. Rows already stored are left alone (NOT VALID checks new rows only).
--   2. every member of the workspace can read the switch and the allow and deny lists (only owners and admins can still change them). The routes that
--      serve a card or a picture judge the card's host against these rules on every read, so a rule added today also hides a card made yesterday; the
--      lists are host names the server may read, nothing a member could not learn by posting a link.
--   3. a card can be removed by the author of its message, by a manager of the message's channel and by a workspace owner or admin (an abusive card on
--      someone else's message must be removable by the people who run the place). Nobody else, and never a hard delete: the row stays as a tombstone.

ALTER TABLE app.link_preview_images DROP CONSTRAINT link_preview_images_bytes_check;
ALTER TABLE app.link_preview_images ADD CONSTRAINT link_preview_images_bytes_check CHECK (octet_length(bytes) BETWEEN 12 AND 524288) NOT VALID;

DROP POLICY link_preview_settings_select ON app.link_preview_settings;
CREATE POLICY link_preview_settings_select ON app.link_preview_settings FOR SELECT
  USING ((SELECT app.is_system()) OR workspace_id = (SELECT app.workspace_id()));
COMMENT ON TABLE app.link_preview_settings IS 'rls: workspace — W: whether link previews are on and which sites are allowed or denied; readable by every member of the workspace, written by workspace owners and admins.';

DROP POLICY link_previews_author_remove ON app.link_previews;
CREATE POLICY link_previews_remove ON app.link_previews FOR UPDATE
  USING (
    channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
    AND (
      EXISTS (SELECT 1 FROM app.messages m WHERE m.id = link_previews.message_id AND m.author_id = (SELECT app.actor()))
      OR app.channel_can(channel_id, 'manage')
      OR (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK (
    workspace_id = (SELECT app.workspace_id())
    AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
    AND removed_by = (SELECT app.actor()));
COMMENT ON TABLE app.link_previews IS 'rls: team — C: the card of one link of one message; readable with the message''s channel (app.visible_channel_ids), removed by the message''s author, a manager of its channel or a workspace admin, created only by the fetch job.';
