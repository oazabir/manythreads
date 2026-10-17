-- bots 0012: delegation depth on a run (bot-to-bot handoff in team channels). Forward-only: never edit once applied.
--
-- bot_runs.delegation_depth: how many bot-authored mentions deep this run sits (0 = a person asked). The router refuses a
-- run past the cap, so two bots naming each other cannot trade model calls forever; every hop still needs an explicit
-- @mention in a public team channel and the author's tasks.handoff grant naming the target.

ALTER TABLE app.bot_runs ADD COLUMN delegation_depth SMALLINT NOT NULL DEFAULT 0;
COMMENT ON COLUMN app.bot_runs.delegation_depth IS 'How many bot-authored mentions deep this run sits (0 = a person asked); the router caps the chain per thread.';
