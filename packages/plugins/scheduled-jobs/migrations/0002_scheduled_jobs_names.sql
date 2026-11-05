-- scheduled-jobs plugin 0002 (P21-15). Forward-only: never edit once applied.
--
-- The plugin was called `rhythms`; the product now says "Jobs" and the code says `scheduled_job` (the kernel already has a job queue,
-- `app.jobs`, so a bare `job` would be ambiguous). After 0001 the schema has the old names on every install, new or old; this file
-- renames them to the final names and moves the rows other tables keep about the old plugin.
--
--  * Tables, the column that points at the job, indexes, constraints, policies and the table comments are renamed in place:
--    no data is copied, grants and row-level security stay attached to the renamed tables.
--  * The fire function is dropped and made again under the new name. Its new body also writes `scheduled-job/<id>` as the task branch
--    and `scheduledJobId` in the card's first history row. Tasks and history rows that already exist keep what they had (a branch
--    may already exist in a team repo).
--  * Events are immutable, so old `rhythms.rhythm.ran` / `runtime.rhythm.*` rows stay as history under their old type. Deliveries still
--    waiting for those types are marked done: no code handles the old names any more.

ALTER TABLE app.rhythms RENAME TO scheduled_jobs;
ALTER TABLE app.rhythm_runs RENAME TO scheduled_job_runs;
ALTER TABLE app.scheduled_job_runs RENAME COLUMN rhythm_id TO scheduled_job_id;

-- Constraint, index and policy names: swap the old words for the new ones (runs table first, so `rhythm_runs` is not read as `rhythm`).
DO $mig$
DECLARE
  r record;
  new_name text;
  swap text[] := ARRAY['rhythm_runs_rhythm', 'scheduled_job_runs_scheduled_job', 'rhythm_runs', 'scheduled_job_runs', 'rhythms', 'scheduled_jobs', 'rhythm_id', 'scheduled_job_id'];
  i int;
BEGIN
  FOR r IN
    SELECT c.conname AS name, c.conrelid::regclass::text AS tbl
    FROM pg_constraint c
    WHERE c.conrelid IN ('app.scheduled_jobs'::regclass, 'app.scheduled_job_runs'::regclass) AND c.conname LIKE '%rhythm%'
  LOOP
    new_name := r.name;
    FOR i IN 1 .. array_length(swap, 1) BY 2 LOOP
      new_name := replace(new_name, swap[i], swap[i + 1]);
    END LOOP;
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.name, new_name);
  END LOOP;

  FOR r IN
    SELECT i.indexname AS name
    FROM pg_indexes i
    WHERE i.schemaname = 'app' AND i.tablename IN ('scheduled_jobs', 'scheduled_job_runs') AND i.indexname LIKE '%rhythm%'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = i.indexname AND k.connamespace = 'app'::regnamespace)
  LOOP
    new_name := r.name;
    FOR i IN 1 .. array_length(swap, 1) BY 2 LOOP
      new_name := replace(new_name, swap[i], swap[i + 1]);
    END LOOP;
    EXECUTE format('ALTER INDEX app.%I RENAME TO %I', r.name, new_name);
  END LOOP;

  FOR r IN
    SELECT p.polname AS name, p.polrelid::regclass::text AS tbl
    FROM pg_policy p
    WHERE p.polrelid IN ('app.scheduled_jobs'::regclass, 'app.scheduled_job_runs'::regclass) AND p.polname LIKE '%rhythm%'
  LOOP
    new_name := r.name;
    FOR i IN 1 .. array_length(swap, 1) BY 2 LOOP
      new_name := replace(new_name, swap[i], swap[i + 1]);
    END LOOP;
    EXECUTE format('ALTER POLICY %I ON %s RENAME TO %I', r.name, r.tbl, new_name);
  END LOOP;
END
$mig$;

COMMENT ON TABLE app.scheduled_jobs IS 'rls: team — T: heartbeat / routine / task schedules; a routine needs its contract path.';
COMMENT ON TABLE app.scheduled_job_runs IS 'rls: team — T: one row per firing; a failed routine keeps its reason.';

-- The firing door, under its new name. -------------------------------------------------------------------------------------------
DROP FUNCTION app.rhythms_fire(uuid, timestamptz, text, text);

CREATE FUNCTION app.scheduled_jobs_fire(p_scheduled_job_id uuid, p_at timestamptz, p_output_path text, p_failure text)
  RETURNS SETOF app.scheduled_job_runs
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_job app.scheduled_jobs;
  v_status text := CASE WHEN p_failure IS NULL THEN 'queued' ELSE 'failed' END;
  v_task uuid;
  v_row app.scheduled_job_runs;
BEGIN
  SELECT * INTO v_job FROM app.scheduled_jobs WHERE id = p_scheduled_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such scheduled job' USING ERRCODE = 'P0002';
  END IF;
  -- `app.is_system()` reads the transaction's actor kind (it is not fooled by this function's owner), which is what the tick job sets.
  IF NOT app.is_system() AND NOT app.lookup_can('team', v_job.team_id, 'manage') THEN
    RAISE EXCEPTION 'only a lead of this team, or the system, can fire a scheduled job' USING ERRCODE = '42501';
  END IF;

  IF v_job.kind = 'task' AND p_failure IS NULL THEN
    INSERT INTO app.tasks (workspace_id, team_id, title, description, kind, priority, branch, created_by)
    VALUES (v_job.workspace_id, v_job.team_id, v_job.name,
            format('Created by the “%s” job.', v_job.name), 'other', 'normal',
            'scheduled-job/' || v_job.id::text, v_job.created_by)
    RETURNING id INTO v_task;
    INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
    VALUES (v_task, v_job.team_id, NULL, 'created', jsonb_build_object('scheduledJobId', v_job.id));
  END IF;

  INSERT INTO app.scheduled_job_runs (scheduled_job_id, team_id, task_id, status, output_path, reason, started_at, ended_at)
  VALUES (p_scheduled_job_id, v_job.team_id, v_task, v_status,
          coalesce(p_output_path, v_job.output_path), left(coalesce(p_failure, ''), 500),
          p_at, CASE WHEN v_status = 'failed' THEN p_at ELSE NULL END)
  RETURNING * INTO v_row;

  RETURN NEXT v_row;
END
$$;

ALTER FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text) TO manythreads_app;

-- Rows other tables keep about the old plugin. They are system-only tables with forced row-level security, so the owner acts as the
-- system role for these statements (the same step kernel 0007 takes). -------------------------------------------------------------
SET ROLE manythreads_system;

-- The plugin list is rewritten at every start; drop the old plugin's row so the list does not show a plugin that no longer exists.
DELETE FROM app.plugins WHERE name = 'rhythms';

-- Waiting deliveries for the old event types can no longer be parsed; close them. Deliveries addressed to the old plugin name
-- (the subscriber is the plugin's name) move to the new one, both waiting and finished ones, so history stays whole.
UPDATE app.outbox o SET done_at = now(), claimed_until = NULL
  FROM app.events e
  WHERE e.id = o.event_id AND o.done_at IS NULL AND o.dead_at IS NULL
    AND e.type IN ('rhythms.rhythm.ran', 'runtime.rhythm.started', 'runtime.rhythm.finished');
UPDATE app.outbox o SET subscriber = 'scheduled-jobs'
  WHERE o.subscriber = 'rhythms'
    AND NOT EXISTS (SELECT 1 FROM app.outbox x WHERE x.event_id = o.event_id AND x.subscriber = 'scheduled-jobs');
UPDATE app.outbox_processed p SET subscriber = 'scheduled-jobs'
  WHERE p.subscriber = 'rhythms'
    AND NOT EXISTS (SELECT 1 FROM app.outbox_processed x WHERE x.event_id = p.event_id AND x.subscriber = 'scheduled-jobs');
DELETE FROM app.event_subscriptions WHERE subscriber = 'rhythms';

-- The once-a-minute tick: the new plugin files its own; close the old queue's waiting rows so nothing is left that nobody runs.
UPDATE app.jobs SET state = 'done', finished_at = now()
  WHERE queue = 'rhythms.tick' AND state = 'ready';

RESET ROLE;
