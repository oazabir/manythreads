-- rhythms plugin 0002 (PLAN P6-08). Forward-only: never edit once applied.
--
--  * Filing a firing is one system-owned door: `rhythms` is writable by a lead, `rhythm_runs` is written only by the system, and a task
--    rhythm creates a card whose `created_by` is the rhythm's own creator (not the caller). The route (a lead's "run now") and the tick job
--    (the system) both call this, so the ledger cannot be written two ways.
--  * The door checks the caller itself: a lead of the rhythm's team, or the system. Inside a definer function owned by manythreads_system
--    `app.is_system()` is true for every caller, so the caller is read from `app.actor()` and its row.

CREATE FUNCTION app.rhythms_fire(p_rhythm_id uuid, p_at timestamptz, p_output_path text, p_failure text)
  RETURNS SETOF app.rhythm_runs
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_rhythm app.rhythms;
  v_status text := CASE WHEN p_failure IS NULL THEN 'queued' ELSE 'failed' END;
  v_task uuid;
  v_row app.rhythm_runs;
BEGIN
  SELECT * INTO v_rhythm FROM app.rhythms WHERE id = p_rhythm_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such rhythm' USING ERRCODE = 'P0002';
  END IF;
  -- `app.is_system()` reads the transaction's actor kind (it is not fooled by this function's owner), which is what the tick job sets.
  IF NOT app.is_system() AND NOT app.lookup_can('team', v_rhythm.team_id, 'manage') THEN
    RAISE EXCEPTION 'only a lead of this team, or the system, can fire a rhythm' USING ERRCODE = '42501';
  END IF;

  IF v_rhythm.kind = 'task' AND p_failure IS NULL THEN
    INSERT INTO app.tasks (workspace_id, team_id, title, description, kind, priority, branch, created_by)
    VALUES (v_rhythm.workspace_id, v_rhythm.team_id, v_rhythm.name,
            format('Created by the “%s” rhythm.', v_rhythm.name), 'other', 'normal',
            'rhythm/' || v_rhythm.id::text, v_rhythm.created_by)
    RETURNING id INTO v_task;
    INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
    VALUES (v_task, v_rhythm.team_id, NULL, 'created', jsonb_build_object('rhythmId', v_rhythm.id));
  END IF;

  INSERT INTO app.rhythm_runs (rhythm_id, team_id, task_id, status, output_path, reason, started_at, ended_at)
  VALUES (p_rhythm_id, v_rhythm.team_id, v_task, v_status,
          coalesce(p_output_path, v_rhythm.output_path), left(coalesce(p_failure, ''), 500),
          p_at, CASE WHEN v_status = 'failed' THEN p_at ELSE NULL END)
  RETURNING * INTO v_row;

  RETURN NEXT v_row;
END
$$;

ALTER FUNCTION app.rhythms_fire(uuid, timestamptz, text, text) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.rhythms_fire(uuid, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rhythms_fire(uuid, timestamptz, text, text) TO manythreads_app;
