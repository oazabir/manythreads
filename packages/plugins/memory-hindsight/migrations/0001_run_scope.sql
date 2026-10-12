-- memory-hindsight 0001: the door through which a run finds its memory bank (PLAN P5-12, SPEC 12.1). Forward-only: never edit once applied.
--
-- A bot cannot name a bank; the platform derives it. The derivation is a database fact, not a parameter: `app.memory_run_scope()` answers for
-- the ONE run the calling transaction carries (`app.run_id()`, which only the kernel's run service sets, in `asBot`/`asReader`) and for nothing
-- else, with the team that run was opened for (the pairing token fixed it) and its slug.
--
--  * It answers only while the run is live (`status = 'running'`, `ended_at IS NULL`): a finished run has no memory door.
--  * It answers only when `app.actor()` is the run's bot or the person who asked: the same pair the run service sets. A transaction that
--    carries a run id but is neither (any other actor) gets no row.
--  * `person_scoped` says whether the run's source log has a `person` line: such a run may recall from the team bank but never retain to it
--    (SPEC 12.1, "a run retains only to memory no wider than the narrowest source it read"). A bot actor cannot read its own run's source
--    lines (their SELECT policy follows team membership), so the check has to live in the definer function.
--  * SECURITY DEFINER owned by manythreads_system, like `app.run_source_log_append`: it reads bot_runs, teams and run_source_log whole. Inside,
--    `app.is_system()` is TRUE, so the caller is checked with `app.actor()` above and never with it.
-- No table: this plugin keeps no state of its own (the bank lives in Hindsight; the audit of what was retained is P5-13's `memory_retain_log`).

CREATE FUNCTION app.memory_run_scope()
  RETURNS TABLE (run_id uuid, team_id uuid, team_slug text, workspace_id uuid, bot_id uuid, person_scoped boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT r.id, r.team_id, t.slug, r.workspace_id, r.bot_id,
         EXISTS (SELECT 1 FROM app.run_source_log l WHERE l.run_id = r.id AND l.scope = 'person')
    FROM app.bot_runs r
    JOIN app.teams t ON t.id = r.team_id
    JOIN app.actors bot_actor ON bot_actor.kind = 'bot' AND bot_actor.ref_id = r.bot_id AND bot_actor.workspace_id = r.workspace_id
   WHERE r.id = app.run_id()
     AND r.status = 'running'
     AND r.ended_at IS NULL
     AND (app.actor() = bot_actor.id OR (r.asker_id IS NOT NULL AND app.actor() = r.asker_id))
$$;

ALTER FUNCTION app.memory_run_scope() OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.memory_run_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_run_scope() TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.memory_run_scope() IS
  'The memory scope of the calling transaction''s live run (app.run_id()): team, slug, bot, and whether the run read anything person-scoped. No row for any other transaction.';
