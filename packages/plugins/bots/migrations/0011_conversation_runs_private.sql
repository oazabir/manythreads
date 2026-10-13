-- bots 0011: a conversation run is its asker's alone (PLAN P5-16 review). Forward-only: never edit once applied.
--
-- `bot_runs_select` (0001) let every reader of a team read every run of its bots: who asked, in which thread, when, how it ended. For a run of
-- the `conversation` trigger that is a person's private use of a bot (the conversation channel is private to them, the Conversations plugin,
-- SPEC §6.2), and the bot page's run list handed it to every teammate, a lead and a workspace admin. The team still reads every other run
-- (mention, routine, channel_message, ...): those happen in a place the team could read anyway.
--
--   * a conversation run is read by its asker, and by nobody else of the app role;
--   * a bot inside its own run reads that run (the one `app.run_id()` names; the kernel sets it, never the caller's SQL);
--   * the system role reads everything, as before: the router, the reaper, the feed, approvals' hand-back and retention work as the system.
--
-- `run_source_log_select` reads its runs through this table (`run_id IN (SELECT r.id FROM app.bot_runs r WHERE ...)`), and a sub-select in a
-- policy is itself subject to the caller's policies, so the lines a conversation run logged follow the same rule with no change of its own.

DROP POLICY bot_runs_select ON app.bot_runs;
CREATE POLICY bot_runs_select ON app.bot_runs FOR SELECT USING (
  (SELECT app.is_system())
  OR (asker_id IS NOT NULL AND asker_id = (SELECT app.actor()))
  OR id = (SELECT app.run_id())
  OR (trigger_type <> 'conversation' AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])));

COMMENT ON TABLE app.bot_runs IS 'rls: team — T: runs of the teams the caller can read (app.readable_team_ids), except runs of the conversation trigger, which only their asker reads (a person''s private use of a bot); the asker reads their own runs and may start one in a team they can read; a bot reads its own live run; status changes are the runtime (system).';
