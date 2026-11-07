-- scheduled-jobs plugin 0004 (P20-R7): the firing door checks who is calling. Forward-only: never edit once applied.
--
-- `app.scheduled_jobs_fire` is a SECURITY DEFINER function owned by the system role. Inside it `app.is_system()` (which is `current_user = 'manythreads_system'`) is TRUE for
-- every caller, so the line `IF NOT app.is_system() THEN <check the caller>` never ran: any member of the workspace could file a firing for any routine (or team job) whose id
-- they knew. The caller is told apart by `session_user`, the login role, which neither definer ownership nor SET ROLE changes (MISTAKES: P2 review; the same test as
-- kernel 0006 and reminders 0002). Only the tick job and the system pool log in as `manythreads_system`; a person's "Run now" and a lead's "Run now" go through the app pool.

GRANT CREATE ON SCHEMA app TO manythreads_system;

DROP FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text);

CREATE FUNCTION app.scheduled_jobs_fire(p_scheduled_job_id uuid, p_at timestamptz, p_output_path text, p_failure text)
  RETURNS SETOF app.scheduled_job_runs
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_job app.scheduled_jobs;
  v_status text := CASE WHEN p_failure IS NULL THEN 'queued' ELSE 'failed' END;
  v_task uuid;
  v_row app.scheduled_job_runs;
  v_me uuid;
BEGIN
  SELECT * INTO v_job FROM app.scheduled_jobs WHERE id = p_scheduled_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such scheduled job' USING ERRCODE = 'P0002';
  END IF;
  IF session_user <> 'manythreads_system' THEN
    IF v_job.owner_person_id IS NOT NULL THEN
      SELECT a.ref_id INTO v_me FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = v_job.workspace_id;
      IF v_me IS DISTINCT FROM v_job.owner_person_id THEN
        RAISE EXCEPTION 'only the owner of a routine, or the system, can fire it' USING ERRCODE = '42501';
      END IF;
    ELSIF NOT coalesce(app.lookup_can('team', v_job.team_id, 'manage'), false) THEN
      RAISE EXCEPTION 'only a lead of this team, or the system, can fire a scheduled job' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_job.kind = 'task' AND p_failure IS NULL AND v_job.team_id IS NOT NULL THEN
    INSERT INTO app.tasks (workspace_id, team_id, title, description, kind, priority, branch, created_by)
    VALUES (v_job.workspace_id, v_job.team_id, v_job.name,
            format('Created by the “%s” job.', v_job.name), 'other', 'normal',
            'scheduled-job/' || v_job.id::text, v_job.created_by)
    RETURNING id INTO v_task;
    INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
    VALUES (v_task, v_job.team_id, NULL, 'created', jsonb_build_object('scheduledJobId', v_job.id));
  END IF;

  INSERT INTO app.scheduled_job_runs (scheduled_job_id, team_id, owner_person_id, task_id, status, output_path, reason, started_at, ended_at)
  VALUES (p_scheduled_job_id, v_job.team_id, v_job.owner_person_id, v_task, v_status,
          coalesce(p_output_path, v_job.output_path), left(coalesce(p_failure, ''), 500),
          p_at, CASE WHEN v_status = 'failed' THEN p_at ELSE NULL END)
  RETURNING * INTO v_row;

  RETURN NEXT v_row;
END
$$;

ALTER FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text) TO manythreads_app;

REVOKE CREATE ON SCHEMA app FROM manythreads_system;
