-- approvals plugin 0003: remember that an approval came from a run (PLAN P5-13 review). Forward-only: never edit once applied.
--
-- `approvals.run_id` is `ON DELETE SET NULL`: a run that is deleted (its bot was removed and its runs went with it) leaves the approval with no run.
-- The re-run of an approved call inherits what the stopped run had read; with no run to read that from, the call would run having "read nothing" and
-- the memory rule (SPEC 12.1) would see a clean run. `had_run` is true for an approval that was filed from a run and never changes, so the resume
-- job can tell "its run is gone" (fail closed: the call is not made) from a row that never had one (none exists today: every door requires a run).
--
-- Set by a trigger, not by `app.approvals_request`: 0001 is deployed and that door is a long function; every insert gets it, whichever door writes.
ALTER TABLE app.approvals ADD COLUMN had_run boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN app.approvals.had_run IS 'The approval was filed from a run (run_id was set at insert). run_id can later be NULL (the run was deleted); had_run stays true.';

CREATE FUNCTION app.approvals_set_had_run() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.had_run := NEW.run_id IS NOT NULL;
  RETURN NEW;
END
$$;
CREATE TRIGGER approvals_had_run BEFORE INSERT ON app.approvals FOR EACH ROW EXECUTE FUNCTION app.approvals_set_had_run();

-- Rows that exist: every door that files an approval requires a run (`app.approvals_request` reads the bot, team and thread from one), so every
-- approval had one — including those whose `run_id` is already NULL because the run was deleted. Not `WHERE run_id IS NOT NULL`: that would
-- record exactly those as "never had a run" and the fail-closed rule would let them through. The system role writes the table (see 0002 for why the
-- migrating role is not enough); a test seeds legacy rows and runs this block.
-- legacy-begin
-- Except the rows of a tool that may never wait (`approvals_never_gated`, 0002, NOT VALID): the constraint is checked on any UPDATE of such a row,
-- and a final legacy row of that kind is history that nothing re-runs, so it keeps `had_run = false`.
SET ROLE manythreads_system;
UPDATE app.approvals SET had_run = true WHERE tool NOT IN ('memory.retain');
RESET ROLE;
-- legacy-end
