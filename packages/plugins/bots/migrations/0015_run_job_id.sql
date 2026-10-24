-- bots 0015: which queue job opened a run. Forward-only: never edit once applied.
--
-- The run job of runtime-hermes opens exactly one run per attempt of a job; recording the job's id on the run lets a retried job find out
-- whether ITS OWN earlier attempt already opened a run (and not another job's run in the same thread), and lets the bot's stable MCP endpoint
-- pick the run a queue job is working on and ignore runs opened some other way (an approval's re-run, a public mint). No foreign key: the
-- jobs table is pruned, a run row is history.
ALTER TABLE app.bot_runs ADD COLUMN job_id uuid;
CREATE INDEX bot_runs_job ON app.bot_runs (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX bot_runs_live_job ON app.bot_runs (bot_id) WHERE ended_at IS NULL AND job_id IS NOT NULL;
