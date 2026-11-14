-- runtime-hermes 0008 (P25-08): who may stop a run, and the flag that stops it on any replica. Forward-only: never edit once applied.
--
-- Stop used to be the asker's alone and lived in one server's memory, so a run on another replica answered "not stopped". Now a Stop is a fact on the run's row
-- (`run_view.stop_requested_at`, `stopped_by_*`): the run job, wherever it runs, looks at it every couple of seconds and stops the agent.
--
-- Who may press it: the person who asked, the person who started the thread (the author of its first message), a lead of the run's team, a workspace admin; and only
-- while they can read the run's channel. A run in a person's own conversation is its asker's alone. Both functions are definers (they write a system-only table and read
-- messages and rosters the caller may not), so they ask who the caller is through the `lookup_*` functions, as kernel 0006 says to.

CREATE FUNCTION app.run_may_stop(p_run_id uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor   uuid := app.actor();
  v_ws      uuid := app.workspace_id();
  v         app.run_view%ROWTYPE;
  v_starter uuid;
BEGIN
  IF v_actor IS NULL OR v_ws IS NULL THEN
    RETURN false;
  END IF;
  SELECT * INTO v FROM app.run_view WHERE run_id = p_run_id AND workspace_id = v_ws;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  -- a run in a private conversation is its asker's alone
  IF v.conversation THEN
    RETURN v.asker_id IS NOT NULL AND v.asker_id = v_actor;
  END IF;
  IF NOT app.lookup_channel_can(v.channel_id, 'read') THEN
    RETURN false;
  END IF;
  IF v.asker_id IS NOT NULL AND v.asker_id = v_actor THEN
    RETURN true;
  END IF;
  IF v.thread_root_id IS NOT NULL THEN
    SELECT m.author_id INTO v_starter FROM app.messages m WHERE m.id = v.thread_root_id;
    IF v_starter IS NOT NULL AND v_starter = v_actor THEN
      RETURN true;
    END IF;
  END IF;
  IF app.lookup_team_role(v.team_id) = 'lead' THEN
    RETURN true;
  END IF;
  RETURN coalesce(app.lookup_workspace_role() IN ('owner', 'admin'), false);
END
$$;

-- Ask for the stop: 'requested' (the first ask), 'already' (somebody asked before), 'ended' (the run is over), 'denied' (not this caller's to press).
CREATE FUNCTION app.run_stop_request(p_run_id uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_name  text;
  v_prior timestamptz;
  v_state text;
BEGIN
  IF NOT app.run_may_stop(p_run_id) THEN
    RETURN 'denied';
  END IF;
  SELECT state, stop_requested_at INTO v_state, v_prior FROM app.run_view WHERE run_id = p_run_id FOR UPDATE;
  IF v_state IS NULL OR v_state IN ('done', 'failed', 'stopped') THEN
    RETURN 'ended';
  END IF;
  IF v_prior IS NOT NULL THEN
    RETURN 'already';
  END IF;
  SELECT p.display_name INTO v_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id WHERE a.id = v_actor AND a.kind = 'person';
  UPDATE app.run_view
     SET stop_requested_at = now(),
         stopped_by_actor = v_actor,
         stopped_by_name = left(coalesce(v_name, 'Someone'), 200),
         state = 'stopping',
         updated_at = now()
   WHERE run_id = p_run_id;
  RETURN 'requested';
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.run_may_stop(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.run_stop_request(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.run_may_stop(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.run_stop_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.run_may_stop(uuid), app.run_stop_request(uuid) TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.run_may_stop(uuid) IS 'May the caller stop this run: the asker, the author of the thread''s first message, a lead of the run''s team, a workspace admin (a conversation run: its asker alone), while they can read its channel.';
COMMENT ON FUNCTION app.run_stop_request(uuid) IS 'Record the caller''s Stop on a run they may stop: requested, already, ended or denied.';
