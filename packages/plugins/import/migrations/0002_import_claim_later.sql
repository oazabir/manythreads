-- import 0002: messages written as a placeholder after its person had already taken it over (PLAN P14-13). Forward-only: never edit once applied.
--
-- 0001 moves a placeholder's messages and reactions to the person at the moment the person's email is verified. An import run that is hours long can write
-- more messages as that placeholder after the move, because the run decided who writes what when it started. Two functions close that gap:
--
--   app.import_move_to(placeholder actor, person actor)   the move itself, now in one place: messages first, then reactions (a person who already reacted
--                                                          keeps one reaction), and the number of messages moved
--   app.import_move_claimed(workspace, source, since)     the import job calls it when a run ends: every placeholder of that archive's source claimed since
--                                                          `since` hands over whatever it still owns
--
-- The claim function of 0001 is replaced so that it uses the same move. Its owner and grants stay as they were.

CREATE FUNCTION app.import_move_to(p_from uuid, p_to uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_moved integer;
BEGIN
  UPDATE app.messages SET author_id = p_to WHERE author_id = p_from;
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  INSERT INTO app.message_reactions (message_id, actor_id, emoji, channel_id, created_at)
    SELECT r.message_id, p_to, r.emoji, r.channel_id, r.created_at FROM app.message_reactions r WHERE r.actor_id = p_from
    ON CONFLICT DO NOTHING;
  DELETE FROM app.message_reactions WHERE actor_id = p_from;
  RETURN v_moved;
END
$$;

CREATE OR REPLACE FUNCTION app.import_claim_for_person(p_person uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws     uuid;
  v_actor  uuid;
  ph       app.import_people;
  v_moved  integer;
  v_total  integer := 0;
  v_event  uuid;
  v_prev   text;
BEGIN
  SELECT p.workspace_id INTO v_ws FROM app.people p WHERE p.id = p_person;
  SELECT a.id INTO v_actor FROM app.actors a WHERE a.kind = 'person' AND a.ref_id = p_person AND a.workspace_id = v_ws;
  IF v_ws IS NULL OR v_actor IS NULL THEN
    RETURN 0;
  END IF;
  FOR ph IN
    SELECT ip.* FROM app.import_people ip
     WHERE ip.workspace_id = v_ws AND ip.claimed_at IS NULL AND ip.email IS NOT NULL
       AND ip.email IN (SELECT lower(e.email) FROM app.person_emails e WHERE e.person_id = p_person AND e.verified_at IS NOT NULL)
     ORDER BY ip.id
       FOR UPDATE OF ip
  LOOP
    v_moved := app.import_move_to(ph.actor_id, v_actor);
    UPDATE app.import_people SET claimed_by = p_person, claimed_at = now() WHERE id = ph.id;
    v_total := v_total + v_moved;
    v_event := uuidv7();
    INSERT INTO app.events (id, workspace_id, team_id, actor_id, type, schema_version, payload)
    VALUES (v_event, v_ws, NULL, v_actor, 'import.person.claimed', 1,
            jsonb_build_object('source', ph.source, 'personId', p_person, 'placeholderActorId', ph.actor_id, 'messages', v_moved, 'at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    -- app.enqueue_outbox only fans out events the current actor wrote: act as the person for that one call
    v_prev := current_setting('app.actor_id', true);
    PERFORM set_config('app.actor_id', v_actor::text, true);
    PERFORM app.enqueue_outbox(v_event);
    PERFORM set_config('app.actor_id', coalesce(v_prev, ''), true);
  END LOOP;
  RETURN v_total;
END
$$;

CREATE FUNCTION app.import_move_claimed(p_workspace uuid, p_source text, p_since timestamptz) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  ph      record;
  v_total integer := 0;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the import job moves what a placeholder still owns' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR ph IN
    SELECT ip.id, ip.actor_id, a.id AS person_actor
      FROM app.import_people ip
      JOIN app.actors a ON a.kind = 'person' AND a.ref_id = ip.claimed_by AND a.workspace_id = ip.workspace_id
     WHERE ip.workspace_id = p_workspace AND ip.source = p_source AND ip.claimed_at IS NOT NULL AND ip.claimed_at >= p_since
     ORDER BY ip.id
       FOR UPDATE OF ip
  LOOP
    v_total := v_total + app.import_move_to(ph.actor_id, ph.person_actor);
  END LOOP;
  RETURN v_total;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.import_move_to(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.import_move_claimed(uuid, text, timestamptz) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.import_move_to(uuid, uuid), app.import_move_claimed(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_move_to(uuid, uuid), app.import_move_claimed(uuid, text, timestamptz) TO manythreads_system;

-- Cancelling a run that no job holds (still queued, or a dry run whose job died) ends it at once from the request, which stamps the time it ended.
GRANT UPDATE (finished_at) ON app.import_runs TO manythreads_app;
