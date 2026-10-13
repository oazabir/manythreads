-- conversations 0002: the sharing door (PLAN P5-17, SPEC §6.2 and §6.3). Forward-only: never edit once applied.
--
-- 0001 made `app.conversations.visibility / shared_to / shared_root_id / shared_by / shared_at` and said the system role writes them (callers
-- have no policy to). This is the one door: the asker of a conversation, who has just posted a masked copy of one of its answers into a channel
-- (the answer plugin's share), marks the conversation shared so that the bot's team lists it under Shared and reads it through that copy.
--
-- It is a SECURITY DEFINER function owned by manythreads_system, so inside it `app.is_system()` is always true: the caller is checked with the
-- actor and the lookup_* helpers, never the is_* ones (MISTAKES P2 review). What it accepts, all of it checked here and none of it argument:
--   * the caller is a person who is a non-guest member of the workspace, and the conversation is theirs (`person_id = app.person_id()`);
--   * the copy is the caller's own live message, in `p_channel`, a channel of kind `channel` they may post in;
--   * the channel belongs to the conversation's own team: a copy posted to another team's channel is not "shared with the team" (that team's
--     readers would see a row they cannot open), so it leaves the conversation private.
-- Answers false when nothing was marked (no such conversation of the caller's, not the bot's team's channel), and refuses (42501) anything else.
CREATE FUNCTION app.conversations_mark_shared(p_thread_root uuid, p_channel uuid, p_copy uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws   uuid := app.workspace_id();
  v_me   uuid := app.person_id();
  v_role text := app.lookup_workspace_role();
  n      integer;
BEGIN
  IF v_ws IS NULL OR v_me IS NULL OR v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'only members of the workspace can share a conversation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(app.lookup_channel_can(p_channel, 'post'), false) OR NOT EXISTS (
    SELECT 1 FROM app.messages m JOIN app.channels ch ON ch.id = m.channel_id
     WHERE m.id = p_copy AND m.channel_id = p_channel AND m.author_id = app.actor() AND m.workspace_id = v_ws
       AND m.deleted_at IS NULL AND ch.kind = 'channel'
  ) THEN
    RAISE EXCEPTION 'the copy is not your message in a channel you may post in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.conversations c
     SET visibility = 'shared', shared_to = p_channel, shared_root_id = p_copy, shared_by = app.actor(), shared_at = now()
   WHERE c.thread_root_id = p_thread_root AND c.person_id = v_me AND c.workspace_id = v_ws
     AND c.team_id = (SELECT ch.team_id FROM app.channels ch WHERE ch.id = p_channel);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;

REVOKE ALL ON FUNCTION app.conversations_mark_shared(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.conversations_mark_shared(uuid, uuid, uuid) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.conversations_mark_shared(uuid, uuid, uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

COMMENT ON FUNCTION app.conversations_mark_shared(uuid, uuid, uuid) IS
  'Marks the caller''s own conversation as shared with its bot''s team, through the masked copy they posted into a channel of that team (conversations plugin; the one writer of the shared_* columns besides the system role).';
