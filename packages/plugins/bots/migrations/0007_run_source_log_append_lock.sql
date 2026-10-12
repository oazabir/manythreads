-- bots 0007: serialise `app.run_source_log_append` per run (review of P5-09/P5-10). Forward-only: never edit once applied.
--
-- 0004 computed the next position as `max(seq) + 1` and inserted it. Two appends of one run in two transactions both read the
-- same maximum and both insert the same `seq`: one of them dies on the primary key (run_id, seq). A run's calls are made in
-- parallel (a model asks for several tools at once, each a transaction of its own), so this is not a theoretical race.
--
-- The fix is a transaction-scoped advisory lock on the run, taken before the maximum is read: the second append waits for the
-- first to commit, then reads the new maximum. `hashtext(run_id::text)` is the 32-bit key (a collision between two runs only
-- makes them wait for each other; it can never produce a wrong position, because the maximum is read after the lock). The
-- function keeps everything 0004 gave it: owner manythreads_system (`app.is_system()` is true inside it), the pinned
-- search_path, and EXECUTE for the app and system roles only.

CREATE OR REPLACE FUNCTION app.run_source_log_append(p_source_type text, p_source_ref text, p_scope text) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_run uuid := app.run_id();
  v_seq integer;
BEGIN
  IF v_run IS NULL THEN
    RAISE EXCEPTION 'app.run_id() is not set: a source line belongs to a run';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_run::text));
  SELECT coalesce(max(seq), -1) + 1 INTO v_seq FROM app.run_source_log WHERE run_id = v_run;
  INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope)
  VALUES (v_run, v_seq, p_source_type, p_source_ref, p_scope);
  RETURN v_seq;
END
$$;

ALTER FUNCTION app.run_source_log_append(text, text, text) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.run_source_log_append(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.run_source_log_append(text, text, text) TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.run_source_log_append(text, text, text) IS
  'Append one line to the calling run''s source log (app.run_id()) and answer its position; serialised per run by an advisory lock, so concurrent appends take consecutive positions.';
