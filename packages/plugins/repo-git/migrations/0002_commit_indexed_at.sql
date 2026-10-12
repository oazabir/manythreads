-- repo-git 0002: when the index learned of a commit, by the database's clock (PLAN P5-13 review). Forward-only: never edit once applied.
--
-- `committed_at` is the git author date: the writer process's clock, to the second, or whatever the committer's machine said for a commit made
-- outside the writer. The memory feed correlates what a bot wrote with the bot's runs by time, and a clock that is not the database's can put a
-- page outside the run that wrote it. `indexed_at` is `now()` of the transaction that recorded the commit: for a normal write it is within the
-- request that made it, on the same clock the runs' `started_at` / `ended_at` use. Rows that exist already take the time of this migration, which no
-- run covers: they fall back to `committed_at`, as before.
ALTER TABLE app.repo_commits ADD COLUMN indexed_at timestamptz NOT NULL DEFAULT now();
COMMENT ON COLUMN app.repo_commits.indexed_at IS 'When the index recorded the commit, by the database clock (committed_at is the git author date).';
