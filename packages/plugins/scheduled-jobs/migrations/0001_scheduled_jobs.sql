-- scheduled-jobs plugin 0001 (PLAN P6-08; SPEC §6.5; renamed from the `rhythms` plugin in P21-15). Forward-only: never edit once applied.
--
--  * This plugin used to be called `rhythms`, and its migrations (namespace `rhythms`) are already applied on every existing install.
--    The tables, columns and function were renamed by 0002. Both paths must reach the same schema, so 0001 builds the old shape
--    on a fresh database (where `app.rhythms` does not exist) and does nothing on an install that already has it; 0002 then renames.
--  * The old files are kept verbatim in test/fixtures/legacy-rhythms/ so a test can build an install the old way and adopt it.
--  * A scheduled job: a prompt on a timer (heartbeat), a contract with a page output (routine), or a recurring task. It always runs as a bot.
--    One row per firing in the runs table, `queued` until the runtime starts it.

DO $mig$
BEGIN
  IF to_regclass('app.rhythms') IS NOT NULL OR to_regclass('app.scheduled_jobs') IS NOT NULL THEN
    RETURN;
  END IF;

CREATE TABLE app.rhythms (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  bot_id        uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  kind          text NOT NULL CHECK (kind IN ('heartbeat', 'routine', 'task')),
  schedule      text NOT NULL CHECK (schedule ~ '^\S+\s+\S+\s+\S+\s+\S+\s+\S+$'),
  model_alias   text CHECK (model_alias IS NULL OR char_length(model_alias) BETWEEN 1 AND 40),
  effort        text CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high')),
  contract_path text CHECK (contract_path IS NULL OR char_length(contract_path) BETWEEN 1 AND 300),
  output_path   text CHECK (output_path IS NULL OR char_length(output_path) BETWEEN 1 AND 300),
  enabled       boolean NOT NULL DEFAULT true,
  next_run_at   timestamptz,
  created_by    uuid NOT NULL REFERENCES app.actors (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rhythms_routine_has_contract CHECK (kind <> 'routine' OR contract_path IS NOT NULL)
);
CREATE INDEX rhythms_team ON app.rhythms (team_id);
CREATE INDEX rhythms_workspace ON app.rhythms (workspace_id);
CREATE INDEX rhythms_bot ON app.rhythms (bot_id);
CREATE INDEX rhythms_due ON app.rhythms (next_run_at) WHERE enabled;
COMMENT ON TABLE app.rhythms IS 'rls: team — T: heartbeat / routine / task schedules; a routine needs its contract path.';

ALTER TABLE app.rhythms ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.rhythms FORCE ROW LEVEL SECURITY;
CREATE POLICY rhythms_select ON app.rhythms FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY rhythms_insert ON app.rhythms FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]) AND created_by = (SELECT app.actor()))
);
CREATE POLICY rhythms_update ON app.rhythms FOR UPDATE USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
) WITH CHECK (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
);
CREATE POLICY rhythms_delete ON app.rhythms FOR DELETE USING ((SELECT app.is_system()));

CREATE TABLE app.rhythm_runs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  rhythm_id   uuid NOT NULL REFERENCES app.rhythms (id) ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  run_id      uuid,
  task_id     uuid,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  output_path text,
  reason      text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE INDEX rhythm_runs_rhythm ON app.rhythm_runs (rhythm_id, id DESC);
CREATE INDEX rhythm_runs_team ON app.rhythm_runs (team_id);
CREATE INDEX rhythm_runs_started_brin ON app.rhythm_runs USING brin (started_at);
COMMENT ON TABLE app.rhythm_runs IS 'rls: team — T: one row per firing; a failed routine keeps its reason.';

ALTER TABLE app.rhythm_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.rhythm_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY rhythm_runs_select ON app.rhythm_runs FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY rhythm_runs_system ON app.rhythm_runs FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

GRANT SELECT, INSERT, UPDATE, DELETE ON app.rhythms TO manythreads_app;
GRANT SELECT ON app.rhythm_runs TO manythreads_app;

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
END
$mig$;
