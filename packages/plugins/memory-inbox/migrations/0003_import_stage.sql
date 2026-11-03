-- memory-inbox 0003: the import step (PLAN P8-25). Forward-only: never edit once applied.
--
-- A received bundle (another team's digest, or an OKF bundle dropped from outside) is already memory-shaped, so it skips the reading and the model: after the hold check it goes to
-- a step of its own, `import`, which checks the whole bundle and files it. The stage list gains `import`, and an item that fails there says so (`failed_stage = import`), so Retry
-- starts again at that step.

ALTER TABLE app.memory_inbox_items DROP CONSTRAINT memory_inbox_items_stage_check;
ALTER TABLE app.memory_inbox_items ADD CONSTRAINT memory_inbox_items_stage_check CHECK (stage IN ('hold', 'extract', 'distil', 'commit', 'import', 'done'));
ALTER TABLE app.memory_inbox_items DROP CONSTRAINT memory_inbox_items_failed_stage_check;
ALTER TABLE app.memory_inbox_items ADD CONSTRAINT memory_inbox_items_failed_stage_check CHECK (failed_stage IS NULL OR failed_stage IN ('extract', 'distil', 'validate', 'commit', 'import'));
