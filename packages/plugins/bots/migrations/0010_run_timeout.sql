-- bots 0010: how long a run of this bot may take (PLAN P5-13 review). Forward-only: never edit once applied.
--
-- `bots.run_timeout_seconds` is the BOT.md `limits.timeoutSeconds` as written, the loader's own projection of one file like `triggers` (0005),
-- `model_aliases` (0008) and `approvers` (0009); NULL when the definition names none. The stale-run reaper (`bots.reap-runs`) reads it: a run still
-- `running` past this plus a grace period is a run whose worker died, and is closed `failed` through the run service, so `bots.run.closed` is
-- emitted and nothing waits on it for ever.
--
-- `run_timeout_known` says the value was read from the definition (by the loader on every load, or by the daily backfill for a bot loaded before this
-- column): NULL with `known = false` means "not read yet", not "no limit". The backfill re-reads only those rows, so a bot that names no limit is
-- not read again every day.
ALTER TABLE app.bots ADD COLUMN run_timeout_seconds integer CHECK (run_timeout_seconds IS NULL OR run_timeout_seconds > 0);
ALTER TABLE app.bots ADD COLUMN run_timeout_known boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN app.bots.run_timeout_seconds IS 'BOT.md limits.timeoutSeconds as written; NULL when none (or not read yet: see run_timeout_known). The loader owns it; the stale-run reaper reads it.';
COMMENT ON COLUMN app.bots.run_timeout_known IS 'run_timeout_seconds was read from the definition (loader or backfill); false for a bot loaded before this column.';
