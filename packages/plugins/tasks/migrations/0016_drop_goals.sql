-- tasks 0016: goals are removed.
-- Why: a goal (a line of work several cards belonged to) was never used by the product: no screen shows it and the bots work from cards, boards and
-- channels. The table, the card's goal_id column and the goal argument of app.tasks_create go away. Cards keep everything else.
-- Every statement says IF EXISTS so a database that went further than this repository (a development copy) still ends the same.

ALTER TABLE app.tasks DROP COLUMN IF EXISTS goal_id;
DROP FUNCTION IF EXISTS app.tasks_goal_spend(uuid);
DROP TABLE IF EXISTS app.goals CASCADE;
DROP TABLE IF EXISTS app.goal_counters CASCADE;
DROP FUNCTION IF EXISTS app.goals_assign_number();

-- tasks_create without the goal. The old eleven-argument form is replaced, not kept beside it, so a call that still passes a goal fails loudly.
DROP FUNCTION IF EXISTS app.tasks_create(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, uuid);
CREATE FUNCTION app.tasks_create(
  p_workspace uuid, p_team uuid, p_title text, p_description text, p_kind text, p_priority text,
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
  INSERT INTO app.tasks (workspace_id, team_id, title, description, kind, priority, branch, environment_id, created_by, board_id)
  VALUES (p_workspace, p_team, p_title, p_description, p_kind, p_priority, p_branch, p_environment, p_created_by, p_board)
  RETURNING * INTO v_task;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (v_task.id, p_team, p_created_by, 'created', jsonb_build_object('kind', p_kind, 'priority', p_priority));
  RETURN NEXT v_task;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_create(uuid, uuid, text, text, text, text, text, uuid, uuid, uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_create(uuid, uuid, text, text, text, text, text, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_create(uuid, uuid, text, text, text, text, text, uuid, uuid, uuid) TO manythreads_app, manythreads_system;
