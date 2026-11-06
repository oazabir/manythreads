-- tasks plugin 0015: custom board columns, where a card sits among them, and the read behind the bot icon on a card. Forward-only: never edit once applied.
--
-- A board's columns stay in `boards.columns` (jsonb, the array order is the display order). Each column now holds `id`, `name`, `state` (and
-- `title`, a copy of `name`). A column stored before this migration holds only `state` and `title`: it is read as id = state, name = title, and is
-- not rewritten. SQL below reads both shapes the same way (coalesce).
--
-- Two columns of a board may count as the same state, so a card needs a place per board. `app.board_card_places` is sparse: a card in the FIRST
-- column of its state has no row. The place is written only by app.tasks_board_place (the door a drag uses), and a trigger drops the row when the
-- card's state changes to a different state, so a tool or a bot that changes the state puts the card back in the first column of the new state.
--
-- app.tasks_card_activity(team): which bots have a run in progress or queued on which cards, for the animated bot icon (reads app.bot_runs.task_id of
-- the bots plugin and the runtime's job queue; plpgsql resolves those names when it runs, so the order of the two plugins' migrations does not matter).

CREATE TABLE app.board_card_places (
  board_id   uuid NOT NULL REFERENCES app.boards (id) ON DELETE CASCADE,
  task_id    uuid NOT NULL REFERENCES app.tasks (id) ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  column_id  text NOT NULL CHECK (column_id ~ '^[a-z0-9_-]{1,40}$'),
  state      text NOT NULL CHECK (state IN ('open', 'in_progress', 'verify', 'waiting_on_person', 'done')),
  placed_by  uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  placed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, task_id)
);
CREATE INDEX board_card_places_task ON app.board_card_places (task_id);
CREATE INDEX board_card_places_team ON app.board_card_places (team_id);
CREATE INDEX board_card_places_placed_by ON app.board_card_places (placed_by) WHERE placed_by IS NOT NULL;
ALTER TABLE app.board_card_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.board_card_places FORCE ROW LEVEL SECURITY;
CREATE POLICY board_card_places_select ON app.board_card_places FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY board_card_places_system ON app.board_card_places FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
REVOKE ALL ON app.board_card_places FROM PUBLIC;
GRANT SELECT ON app.board_card_places TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.board_card_places TO manythreads_system;
COMMENT ON TABLE app.board_card_places IS 'rls: team — T: the column a card sits in on a board when it is not the first column of its state; read by the teams the caller can read, written only by app.tasks_board_place and the state trigger.';

-- The place door. The caller must be able to post in the board's team (and in its channel, for a channel board); the card must belong to the
-- board (a channel board: filed on it; a team board: same team); the column must exist on the board and count as the card's CURRENT state.
-- Placing a card in the first column of its state removes its row. Answers 'placed', 'not_found', 'no_column' or 'wrong_state'.
CREATE FUNCTION app.tasks_board_place(p_board uuid, p_task uuid, p_column text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_board app.boards;
  v_task app.tasks;
  v_col_state text;
  v_first text;
BEGIN
  SELECT * INTO v_board FROM app.boards WHERE id = p_board;
  IF NOT FOUND OR NOT (v_board.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]))
     OR (v_board.channel_id IS NOT NULL AND NOT (v_board.channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]))) THEN
    RETURN 'not_found';
  END IF;
  SELECT * INTO v_task FROM app.tasks WHERE id = p_task AND team_id = v_board.team_id;
  IF NOT FOUND OR (v_board.channel_id IS NOT NULL AND v_task.board_id IS DISTINCT FROM v_board.id) THEN
    RETURN 'not_found';
  END IF;
  SELECT c->>'state' INTO v_col_state
    FROM jsonb_array_elements(v_board.columns) AS c
   WHERE coalesce(c->>'id', c->>'state') = p_column;
  IF v_col_state IS NULL THEN RETURN 'no_column'; END IF;
  IF v_col_state <> v_task.state THEN RETURN 'wrong_state'; END IF;
  SELECT coalesce(c->>'id', c->>'state') INTO v_first
    FROM jsonb_array_elements(v_board.columns) WITH ORDINALITY AS t(c, n)
   WHERE c->>'state' = v_task.state ORDER BY n LIMIT 1;
  IF v_first = p_column THEN
    DELETE FROM app.board_card_places WHERE board_id = p_board AND task_id = p_task;
  ELSE
    INSERT INTO app.board_card_places (board_id, task_id, team_id, column_id, state, placed_by)
    VALUES (p_board, p_task, v_board.team_id, p_column, v_task.state, app.actor())
    ON CONFLICT (board_id, task_id) DO UPDATE SET column_id = EXCLUDED.column_id, state = EXCLUDED.state, placed_by = EXCLUDED.placed_by, placed_at = now();
  END IF;
  RETURN 'placed';
END
$$;

-- A card whose state changes falls back to the first column of the new state: its places on every board are dropped when they no longer match.
CREATE FUNCTION app.tasks_drop_stale_places() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  DELETE FROM app.board_card_places WHERE task_id = NEW.id AND state <> NEW.state;
  RETURN NEW;
END
$$;
CREATE TRIGGER tasks_drop_stale_places AFTER UPDATE OF state ON app.tasks
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION app.tasks_drop_stale_places();

-- Which bots work on which cards of a team. 'running': a live run of the bot whose task is the card (bot_runs.task_id, index bot_runs_live_task).
-- 'queued': a run job waiting in the runtime's queue `runtime-hermes.run` (a name coupled to that plugin) that carries the card in its payload.
-- Only cards of teams the caller can read, and for a channel board only when the caller can read the channel. At most 200 cards.
CREATE FUNCTION app.tasks_card_activity(p_team uuid) RETURNS TABLE (task_id uuid, bot_actor_id uuid, phase text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF p_team IS NULL OR NOT (p_team = ANY ((SELECT app.readable_team_ids('read'))::uuid[])) THEN RETURN; END IF;
  RETURN QUERY
  WITH visible AS (SELECT (SELECT app.visible_channel_ids('read'))::uuid[] AS ids),
  live AS (
    SELECT r.task_id AS tid, a.id AS aid, 'running'::text AS ph
      FROM app.bot_runs r
      JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = r.bot_id AND a.workspace_id = r.workspace_id
     WHERE r.team_id = p_team AND r.ended_at IS NULL AND r.task_id IS NOT NULL
  ),
  waiting AS (
    SELECT (j.payload->>'taskId')::uuid AS tid, a.id AS aid, 'queued'::text AS ph
      FROM app.jobs j
      JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = (j.payload->>'botId')::uuid
     WHERE j.queue = 'runtime-hermes.run' AND j.state = 'ready' AND j.payload->>'teamId' = p_team::text
       AND j.payload->>'taskId' IS NOT NULL
  ),
  merged AS (
    SELECT * FROM live
    UNION ALL
    SELECT w.* FROM waiting w WHERE NOT EXISTS (SELECT 1 FROM live l WHERE l.tid = w.tid AND l.aid = w.aid)
  )
  SELECT m.tid, m.aid, m.ph
    FROM merged m
    JOIN app.tasks t ON t.id = m.tid AND t.team_id = p_team
    LEFT JOIN app.boards b ON b.id = t.board_id
    CROSS JOIN visible v
   WHERE (b.channel_id IS NULL OR b.channel_id = ANY (v.ids))
   ORDER BY m.tid, m.ph DESC, m.aid
   LIMIT 200;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_board_place(uuid, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_drop_stale_places() OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_card_activity(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_board_place(uuid, uuid, text), app.tasks_drop_stale_places(), app.tasks_card_activity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_board_place(uuid, uuid, text), app.tasks_card_activity(uuid) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.tasks_board_place(uuid, uuid, text) IS 'Puts a card in a column of a board (the column must count as the card''s current state); the first column of a state is the default and stores no row.';
COMMENT ON FUNCTION app.tasks_card_activity(uuid) IS 'The bots with a run in progress or queued on cards of a team the caller can read (the bot icon on a card).';
