-- rhythms plugin 0001 (PLAN P6-08; SPEC §6.5). Forward-only: never edit once applied.
--
--  * rhythms: a prompt on a timer (heartbeat), a contract with a page output (routine), or a recurring task. It always runs as a bot.
--  * rhythm_runs: one row per firing, `queued` until the runtime starts it; a failed routine keeps its reason, so the screen can say why.
--  * The tick job (`rhythms.tick`, every minute) advances next_run_at and files the runs; a run is queued in the same transaction as the
--    advance, so a crash cannot skip a slot or fire one twice.

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
