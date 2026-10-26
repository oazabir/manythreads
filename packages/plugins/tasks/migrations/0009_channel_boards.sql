-- tasks plugin 0009: a board can belong to a channel, and a card can be filed on a board. Forward-only: never edit once applied.
--
-- Why: a bot that splits a goal into cards had nothing tying them to the channel the work happened in. A board used to be only a saved
-- filter of the team. Now a board may be attached to one channel (`boards.channel_id`); such a board shows the cards filed on it
-- (`tasks.board_id`) instead of a saved filter, and only people who can read the channel can see it.
--
--  * boards.channel_id: nullable, ON DELETE CASCADE (the board goes with its channel). One board per channel and name: the unique index
--    is what lets the "Bot Board" get-or-create converge on one row when two runs ask at once.
--  * tasks.board_id: nullable, ON DELETE SET NULL (a deleted board leaves its cards on the team's list).
--  * RLS: a channel board is read through the hoisted visible-channel set, like every message policy; a board is written only by someone
--    who can post in the channel. A trigger keeps a board on its channel's own team.
--  * app.tasks_create takes an optional board (the old ten-argument form is replaced, not kept beside it, so a call with ten arguments
--    is never ambiguous) and checks it: same team, and a channel board only for someone who can read the channel.
--  * app.tasks_run_channel(): the team channel the caller's live bot run answers in, for the default board of a bot's card.

ALTER TABLE app.boards ADD COLUMN channel_id uuid REFERENCES app.channels (id) ON DELETE CASCADE;
CREATE INDEX boards_channel ON app.boards (channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX boards_channel_name ON app.boards (channel_id, name) WHERE channel_id IS NOT NULL;
COMMENT ON COLUMN app.boards.channel_id IS 'The channel this board belongs to; NULL for a team-level saved view. Readable only by people who can read the channel.';

ALTER TABLE app.tasks ADD COLUMN board_id uuid REFERENCES app.boards (id) ON DELETE SET NULL;
CREATE INDEX tasks_board ON app.tasks (board_id, updated_at DESC) WHERE board_id IS NOT NULL;
COMMENT ON COLUMN app.tasks.board_id IS 'The channel board this card is filed on, if any; a handover never changes it.';

DROP POLICY boards_select ON app.boards;
DROP POLICY boards_insert ON app.boards;
DROP POLICY boards_update ON app.boards;
CREATE POLICY boards_select ON app.boards FOR SELECT USING (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
      AND (channel_id IS NULL OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])))
);
CREATE POLICY boards_insert ON app.boards FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) AND created_by = (SELECT app.actor())
      AND (channel_id IS NULL OR channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])))
);
CREATE POLICY boards_update ON app.boards FOR UPDATE USING (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])
      AND (channel_id IS NULL OR channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])))
) WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])
      AND (channel_id IS NULL OR channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])))
);

-- A channel board lives on its channel's team (the trigger reads the channel as its owner, so it sees the row whatever the caller reads).
CREATE FUNCTION app.boards_check_channel() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.channel_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.channels c WHERE c.id = NEW.channel_id AND c.team_id = NEW.team_id AND c.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'a board can only be attached to a channel of its own team' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER boards_check_channel BEFORE INSERT OR UPDATE OF channel_id, team_id ON app.boards
  FOR EACH ROW EXECUTE FUNCTION app.boards_check_channel();

-- The team channel the caller's live bot run answers in (the channel of the message its reply hangs from, else the run's own channel).
-- Answers NULL for a person, a run that has ended, a direct message or a bot conversation. Never raises.
CREATE FUNCTION app.tasks_run_channel() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT c.id
    FROM app.bot_runs r
    JOIN app.actors bot ON bot.kind = 'bot' AND bot.ref_id = r.bot_id AND bot.workspace_id = r.workspace_id
    LEFT JOIN app.messages m ON m.id = r.reply_root_id AND m.workspace_id = r.workspace_id AND m.deleted_at IS NULL
    JOIN app.channels c ON c.id = coalesce(m.channel_id, r.channel_id) AND c.kind = 'channel' AND c.archived_at IS NULL
   WHERE r.id = app.run_id() AND r.status = 'running' AND r.ended_at IS NULL AND bot.id = app.actor()
$$;

-- tasks_create with a board. The old signature goes away; the grants are repeated for the new one.
DROP FUNCTION app.tasks_create(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid);
CREATE FUNCTION app.tasks_create(
  p_workspace uuid, p_team uuid, p_goal uuid, p_title text, p_description text, p_kind text, p_priority text,
  p_branch text, p_environment uuid, p_created_by uuid, p_board uuid DEFAULT NULL
) RETURNS SETOF app.tasks
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_task app.tasks;
  v_board_channel uuid;
BEGIN
  IF p_created_by IS DISTINCT FROM app.actor() THEN
    RAISE EXCEPTION 'a card is created by its caller' USING ERRCODE = '42501';
  END IF;
  IF p_team IS NULL OR NOT (p_team = ANY ((SELECT app.readable_team_ids('post'))::uuid[])) THEN
    RAISE EXCEPTION 'not a member of this team' USING ERRCODE = '42501';
  END IF;
  IF p_goal IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.goals g WHERE g.id = p_goal AND g.team_id = p_team) THEN
    RAISE EXCEPTION 'no such goal in this team' USING ERRCODE = '23503';
  END IF;
  IF p_environment IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.environments e WHERE e.id = p_environment AND e.team_id = p_team) THEN
    RAISE EXCEPTION 'no such environment in this team' USING ERRCODE = '23503';
  END IF;
  IF p_board IS NOT NULL THEN
    SELECT b.channel_id INTO v_board_channel FROM app.boards b WHERE b.id = p_board AND b.team_id = p_team;
    IF NOT FOUND
       OR (v_board_channel IS NOT NULL AND NOT (v_board_channel = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]))) THEN
      RAISE EXCEPTION 'no such board in this team' USING ERRCODE = '23503';
    END IF;
  END IF;
  INSERT INTO app.tasks (workspace_id, team_id, goal_id, title, description, kind, priority, branch, environment_id, created_by, board_id)
  VALUES (p_workspace, p_team, p_goal, p_title, p_description, p_kind, p_priority, p_branch, p_environment, p_created_by, p_board)
  RETURNING * INTO v_task;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (v_task.id, p_team, p_created_by, 'created', jsonb_build_object('kind', p_kind, 'priority', p_priority));
  RETURN NEXT v_task;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_create(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_run_channel() OWNER TO manythreads_system;
ALTER FUNCTION app.boards_check_channel() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_create(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, uuid), app.tasks_run_channel(), app.boards_check_channel() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_create(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, uuid), app.tasks_run_channel()
  TO manythreads_app, manythreads_system;
