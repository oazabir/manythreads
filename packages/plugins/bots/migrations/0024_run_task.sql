-- bots plugin 0024: a run can name the card it works on. Forward-only: never edit once applied.
--
-- `task_id` is set when a run starts for a card (a `task_assigned` run, or a bot that claims a card during its run). It has no foreign key, like
-- `job_id`: a run's record must outlive the card. The partial index is the "what is this bot doing now" read: live runs that have a card, by team.
ALTER TABLE app.bot_runs ADD COLUMN task_id uuid;
CREATE INDEX bot_runs_live_task ON app.bot_runs (team_id, task_id) WHERE ended_at IS NULL AND task_id IS NOT NULL;
COMMENT ON COLUMN app.bot_runs.task_id IS 'The card this run works on, or NULL. No foreign key: the run record outlives the card. Drives the bot icon on a board card.';
