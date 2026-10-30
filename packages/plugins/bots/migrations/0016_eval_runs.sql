-- bots 0016: runs of a bot's scenario set (PLAN P7-08, SPEC section 8). Forward-only: never edit once applied.
--
-- One row per run of the set that BOT.md's `evals.set` names: started by a lead or admin on demand, by a commit that changed the bot's BOT.md or its set
-- file, or by the nightly pass. The verdict on every case is kept in `results` (a short, bounded array: a set has at most 100 cases) so the Evals tab can
-- show which cases failed and why without reading the repo at that commit again. `ok` is `score >= min_score`; false is what the bot page flags.
--
-- Everyone who can read the team reads the runs (the set file is readable by the team anyway); a lead or workspace admin inserts the first state of an
-- on-demand run (`status = 'running'`, nothing counted); every later change is the system role, which is the job that does the work.

CREATE TABLE app.bot_eval_runs (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  bot_id        uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  bot_slug      text NOT NULL CHECK (bot_slug ~ '^[a-z0-9][a-z0-9._-]*$'),
  set_name      text NOT NULL CHECK (char_length(set_name) BETWEEN 1 AND 64),
  -- the repo commit the definition and the set were read at; NULL while the job has not read them yet
  commit_sha    text CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40,64}$'),
  trigger       text NOT NULL CHECK (trigger IN ('on_demand', 'on_commit', 'nightly')),
  mode          text NOT NULL CHECK (mode IN ('static', 'model')),
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed')),
  requested_by  uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  min_score     double precision NOT NULL DEFAULT 0 CHECK (min_score >= 0 AND min_score <= 1),
  total         integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  judged        integer NOT NULL DEFAULT 0 CHECK (judged >= 0),
  passed        integer NOT NULL DEFAULT 0 CHECK (passed >= 0),
  score         double precision CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  ok            boolean,
  cost_tokens   integer NOT NULL DEFAULT 0 CHECK (cost_tokens >= 0),
  error         text CHECK (error IS NULL OR char_length(error) <= 1000),
  results       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) <= 100),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CONSTRAINT bot_eval_runs_finished_together CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT bot_eval_runs_passed_within_judged CHECK (passed <= judged AND judged <= total)
);
CREATE INDEX bot_eval_runs_bot_newest ON app.bot_eval_runs (bot_id, id DESC);
CREATE INDEX bot_eval_runs_workspace ON app.bot_eval_runs (workspace_id);
CREATE INDEX bot_eval_runs_team ON app.bot_eval_runs (team_id);
CREATE INDEX bot_eval_runs_requested_by ON app.bot_eval_runs (requested_by) WHERE requested_by IS NOT NULL;
CREATE INDEX bot_eval_runs_running ON app.bot_eval_runs (started_at) WHERE status = 'running';
COMMENT ON TABLE app.bot_eval_runs IS 'rls: team — T: runs of a bot''s scenario set for the teams the caller can read (app.readable_team_ids); a lead or workspace admin starts an on-demand run (initial state only), every later change is the system role.';

ALTER TABLE app.bot_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_eval_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY bot_eval_runs_select ON app.bot_eval_runs FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))
);
-- the initial state of an on-demand run, by someone who may manage the team, naming themselves; the bot must be this team's own
CREATE POLICY bot_eval_runs_insert ON app.bot_eval_runs FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (
    workspace_id = (SELECT app.workspace_id())
    AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
    AND trigger = 'on_demand' AND status = 'running' AND finished_at IS NULL
    AND requested_by = (SELECT app.actor())
    AND passed = 0 AND judged = 0 AND total = 0 AND score IS NULL AND ok IS NULL AND results = '[]'::jsonb
    AND EXISTS (SELECT 1 FROM app.bots b WHERE b.id = bot_id AND b.team_id = bot_eval_runs.team_id)
  )
);
CREATE POLICY bot_eval_runs_update ON app.bot_eval_runs FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY bot_eval_runs_delete ON app.bot_eval_runs FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT ON app.bot_eval_runs TO manythreads_app;
