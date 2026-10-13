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
--   * the channel belongs to the conversation's own team AND is not private: a copy posted to another team's channel, or into a private room of
--     the team, is not "shared with the team" (teammates outside the room would see a row they cannot open, and learn that a share happened),
--     so it leaves the conversation private. The copy is posted all the same.
--   * the copy is a copy OF THIS CONVERSATION's answer: the answer plugin's share log (`app.answer_shares`, written by `answer_share_record`
--     just before this is called) says the caller shared an answer of that thread as exactly that message;
--   * the mark follows the copy: deleting it (a trigger below) makes the conversation private again, or points it at an older live copy.
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
  IF NOT EXISTS (
    SELECT 1 FROM app.answer_shares s JOIN app.messages am ON am.id = s.message_id
     WHERE s.kind = 'channel' AND s.copy_message_id = p_copy AND s.shared_by = v_me AND am.thread_root_id = p_thread_root
  ) THEN
    RAISE EXCEPTION 'the copy is not a copy of an answer of this conversation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.conversations c
     SET visibility = 'shared', shared_to = p_channel, shared_root_id = p_copy, shared_by = app.actor(), shared_at = now()
   WHERE c.thread_root_id = p_thread_root AND c.person_id = v_me AND c.workspace_id = v_ws
     AND EXISTS (SELECT 1 FROM app.channels ch WHERE ch.id = p_channel AND ch.team_id = c.team_id AND NOT ch.private);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;

-- A shared mark with no copy behind it is a dead row (a person, a time, no title) in everybody's Shared list. When a copy is deleted the
-- conversation that was shared through it is private again. (The lists also read the copy itself, so a row whose copy is gone is never listed.)
CREATE INDEX conversations_shared_root ON app.conversations (shared_root_id) WHERE shared_root_id IS NOT NULL;

CREATE FUNCTION app.conversations_copy_deleted() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  c app.conversations;
  r record;
BEGIN
  FOR c IN SELECT * FROM app.conversations WHERE shared_root_id = NEW.id LOOP
    -- another live copy of an answer of the same conversation, in a channel the whole team reads, keeps it shared; none makes it private
    SELECT s.copy_message_id, s.channel_id, cm.author_id, cm.created_at INTO r
      FROM app.answer_shares s
      JOIN app.messages am ON am.id = s.message_id AND am.thread_root_id = c.thread_root_id
      JOIN app.messages cm ON cm.id = s.copy_message_id AND cm.deleted_at IS NULL AND cm.id <> NEW.id
      JOIN app.channels ch ON ch.id = cm.channel_id AND ch.kind = 'channel' AND NOT ch.private AND ch.team_id = c.team_id
     WHERE s.kind = 'channel' AND s.shared_by = c.person_id
     ORDER BY s.created_at DESC
     LIMIT 1;
    IF FOUND THEN
      -- (guarded by the copy that was deleted: a share that pointed the row at another copy meanwhile is not undone here)
      UPDATE app.conversations SET shared_to = r.channel_id, shared_root_id = r.copy_message_id, shared_by = r.author_id, shared_at = r.created_at
       WHERE thread_root_id = c.thread_root_id AND shared_root_id = NEW.id;
    ELSE
      UPDATE app.conversations
         SET visibility = 'private', shared_to = NULL, shared_root_id = NULL, shared_by = NULL, shared_at = NULL
       WHERE thread_root_id = c.thread_root_id AND shared_root_id = NEW.id;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER conversations_copy_deleted AFTER UPDATE OF deleted_at ON app.messages
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION app.conversations_copy_deleted();

REVOKE ALL ON FUNCTION app.conversations_mark_shared(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.conversations_copy_deleted() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.conversations_mark_shared(uuid, uuid, uuid) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.conversations_mark_shared(uuid, uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.conversations_copy_deleted() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

COMMENT ON FUNCTION app.conversations_mark_shared(uuid, uuid, uuid) IS
  'Marks the caller''s own conversation as shared with its bot''s team, through the masked copy they posted into a channel of that team (conversations plugin; the one writer of the shared_* columns besides the system role).';
