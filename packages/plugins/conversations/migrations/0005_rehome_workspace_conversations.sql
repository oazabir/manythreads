-- conversations 0005 (P20-07): a conversation with the workspace Brain follows its person to their oldest remaining team. Forward-only.
--
-- 0004 made the conversation channel of a person and the workspace Brain once, in the person's oldest team of that moment, and a channel's team never changes (channels_guard
-- refuses a change unless the connection is the real manythreads_system role). A person who then left that team could neither read nor post in the channel (the visibility
-- set requires membership of the channel's team), yet conversations_open still handed the channel back.
--
--  * app.conversations_rehome(person): the system-role step. For every conversation channel of the workspace Brain whose person no longer sits in the channel's team, in ONE
--    transaction of the caller: the channel moves to the person's oldest non-archived team (the same order as app.workspace_bot_context_team), and so do the index rows
--    (`conversations`), the files uploaded into the channel and the person's scheduled messages in it. Messages, threads, ids and the channel's single member stay as they
--    are, so every thread and its history are read under the new team. A conversation that was shared with the old team becomes private again (its copy stays in the old
--    team's channel; the new team was never told, and a mark that points into another team's channel would list a row nobody there can open). A person of NO team (left all
--    of them) keeps the channel untouched: nobody else can read it, nothing is deleted, and retention owns it from there. The runs already made keep the team they ran in
--    (`bot_runs.team_id` is history). Idempotent: once the person sits in the channel's team the channel is no longer selected. Answers one row per channel moved, ids only,
--    so the caller can announce it (`conversations.conversation.moved`). `p_person_id` NULL sweeps every person. Callable by the real system role only.
--
--  * app.conversations_open: when the person's channel with the workspace Brain is still in a team they have left (the move has not run yet), it says so in plain words
--    instead of handing back a channel they cannot use. A person of no team is told to join one (0004 already did).
CREATE OR REPLACE FUNCTION app.conversations_open(p_bot_id uuid) RETURNS TABLE (channel_id uuid, created boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws       uuid := app.workspace_id();
  v_role     text := app.lookup_workspace_role();
  v_me       uuid;
  v_team     uuid;
  v_scope    text;
  v_found    boolean;
  v_status   text;
  v_new      uuid := uuidv7();
  v_channel  uuid;
  v_old_team uuid;
  v_has_old  boolean;
BEGIN
  SELECT a.ref_id INTO v_me FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = v_ws;
  -- A guest's reach is the channels they were granted, and a bot does not talk to a bot: neither opens a conversation.
  IF v_me IS NULL OR v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'only members of the workspace can talk to a bot' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT b.team_id, b.status, b.scope, true INTO v_team, v_status, v_scope, v_found FROM app.bots b WHERE b.id = p_bot_id AND b.workspace_id = v_ws;
  IF v_found IS NOT TRUE THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_scope = 'workspace' AND v_team IS NULL THEN
    v_team := app.workspace_bot_context_team(v_me);
    IF v_team IS NULL THEN
      RAISE EXCEPTION 'join a team first: the Brain answers in the context of one of your teams' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- The channel was made in a team the person has since left: it is moving to their current team, and until it has moved they could neither read nor post in it.
    SELECT c.team_id, true INTO v_old_team, v_has_old
      FROM app.channels c WHERE c.workspace_id = v_ws AND c.bot_id = p_bot_id AND c.created_by = app.actor() AND c.kind = 'bot_conversation';
    IF v_has_old IS TRUE AND NOT EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                                          WHERE tm.team_id = v_old_team AND a.ref_id = v_me) THEN
      RAISE EXCEPTION 'your conversation is moving to your current team; try again in a moment' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- The run that answers is opened for a person of the run's team (ctx.runs.open refuses anybody else), so only they may start one.
  IF NOT EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                  WHERE tm.team_id = v_team AND a.ref_id = v_me) THEN
    RAISE EXCEPTION 'only people of the bot''s team can talk to it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'this bot is not active' USING ERRCODE = 'check_violation';
  END IF;
  WITH ch AS (
    INSERT INTO app.channels AS c (id, workspace_id, team_id, name, kind, private, bot_id, created_by)
    VALUES (v_new, v_ws, v_team, '', 'bot_conversation', true, p_bot_id, app.actor())
    ON CONFLICT (workspace_id, bot_id, created_by) WHERE kind = 'bot_conversation' DO SELECT
    RETURNING c.id
  ), members AS (
    INSERT INTO app.channel_members (channel_id, person_id)
    SELECT ch.id, v_me FROM ch
    ON CONFLICT DO NOTHING
  )
  SELECT ch.id INTO v_channel FROM ch;
  RETURN QUERY SELECT v_channel, v_channel = v_new;
END
$$;

CREATE FUNCTION app.conversations_rehome(p_person_id uuid DEFAULT NULL)
  RETURNS TABLE (moved_channel_id uuid, moved_workspace_id uuid, moved_bot_id uuid, moved_person_id uuid, from_team_id uuid, to_team_id uuid)
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r    record;
  v_to uuid;
BEGIN
  -- The channels guard lets a channel change team only on a connection of the real system role; say it here, in words, rather than from deep inside the update.
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the system role moves a conversation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN
    SELECT c.id AS channel_id, c.workspace_id, c.bot_id, c.team_id AS old_team, a.id AS actor_id, a.ref_id AS person_id
      FROM app.bots b
      JOIN app.channels c ON c.workspace_id = b.workspace_id AND c.bot_id = b.id AND c.kind = 'bot_conversation'
      JOIN app.actors a ON a.id = c.created_by AND a.kind = 'person'
     WHERE b.scope = 'workspace'
       AND (p_person_id IS NULL OR a.ref_id = p_person_id)
       AND NOT EXISTS (SELECT 1 FROM app.team_members tm WHERE tm.team_id = c.team_id AND tm.actor_id = a.id)
     ORDER BY c.id
       FOR UPDATE OF c
  LOOP
    SELECT tm.team_id INTO v_to
      FROM app.team_members tm
      JOIN app.teams t ON t.id = tm.team_id AND t.archived_at IS NULL AND t.workspace_id = r.workspace_id
     WHERE tm.actor_id = r.actor_id
     ORDER BY tm.created_at, tm.team_id
     LIMIT 1;
    -- no team left: the channel stays as it is (the person's only; unreadable to everybody else) for retention
    CONTINUE WHEN v_to IS NULL;
    UPDATE app.channels SET team_id = v_to, updated_at = now() WHERE id = r.channel_id;
    UPDATE app.conversations
       SET team_id = v_to, visibility = 'private', shared_to = NULL, shared_root_id = NULL, shared_by = NULL, shared_at = NULL
     WHERE channel_id = r.channel_id;
    UPDATE app.files SET team_id = v_to WHERE channel_id = r.channel_id AND team_id IS NOT DISTINCT FROM r.old_team;
    UPDATE app.scheduled_messages SET team_id = v_to WHERE channel_id = r.channel_id AND team_id IS NOT DISTINCT FROM r.old_team;
    moved_channel_id := r.channel_id;
    moved_workspace_id := r.workspace_id;
    moved_bot_id := r.bot_id;
    moved_person_id := r.person_id;
    from_team_id := r.old_team;
    to_team_id := v_to;
    RETURN NEXT;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION app.conversations_rehome(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.conversations_rehome(uuid) TO manythreads_system;
COMMENT ON FUNCTION app.conversations_rehome(uuid) IS
  'Moves the workspace Brain conversation channel of a person who left its team (or of everybody, with NULL) to their oldest remaining team, with its index rows, files and scheduled messages, in the caller''s transaction. System role only; idempotent; one row per channel moved.';
