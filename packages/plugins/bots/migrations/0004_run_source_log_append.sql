-- bots 0004: append door for `run_source_log` (PLAN P5-09, the MCP gateway's "what the run read").
--
-- Why a function and not the plain INSERT the policy allows: the next `seq` has to be read from the run's own lines,
-- and the table's SELECT policy makes a run's lines readable with the run's *team* — a bot actor is not a member of
-- it, so for a bot `max(seq)` is always NULL and `INSERT ... RETURNING` fails the SELECT policy on the row it is
-- returning (`new row violates row-level security policy`). Inside a function owned by manythreads_system,
-- `app.is_system()` is true (a name comparison, kernel 0003), so the position is read whole and the line inserted in
-- the caller's own transaction: it commits with the read that produced it, and lines appended earlier in the same
-- transaction are counted. `app.run_id()` is the only run this door can touch — a caller cannot name another run,
-- exactly like the INSERT policy it stands beside.

CREATE FUNCTION app.run_source_log_append(p_source_type text, p_source_ref text, p_scope text) RETURNS integer
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
  'Append one line to the calling run''s source log (app.run_id()) and answer its position; the run''s own transaction owns the line.';
