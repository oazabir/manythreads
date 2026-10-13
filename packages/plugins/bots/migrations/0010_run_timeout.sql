-- bots 0010: how long a run of this bot may take (PLAN P5-13 review). Forward-only: never edit once applied.
--
-- `bots.run_timeout_seconds` is the BOT.md `limits.timeoutSeconds` as written, the loader's own projection of one file like `triggers` (0005),
-- `model_aliases` (0008) and `approvers` (0009); NULL when the definition names none (or the bot was loaded before this column: it is filled on
-- the next load). The stale-run reaper (`bots.reap-runs`) reads it: a run still `running` past this plus a grace period is a run whose worker died,
-- and is closed `failed` through the run service, so `bots.run.closed` is emitted and nothing waits on it for ever.
ALTER TABLE app.bots ADD COLUMN run_timeout_seconds integer CHECK (run_timeout_seconds IS NULL OR run_timeout_seconds > 0);
COMMENT ON COLUMN app.bots.run_timeout_seconds IS 'BOT.md limits.timeoutSeconds as written; NULL when none. The loader owns it; the stale-run reaper reads it.';
