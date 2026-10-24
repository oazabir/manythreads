-- tasks plugin 0003: hardening of the card announcement (0002 was not deployed anywhere; this file replaces its function instead of editing it,
-- so a database that did apply 0002 ends in the same place). Forward-only: never edit once applied.
--
--  * app.tasks_record_card now refuses (raises) a message that is not the sender's own, or that sits in a channel outside the card's team,
--    instead of returning without a word: the caller records the miss on the card.
--  * task_events gains the `not_woken` type and app.tasks_note_event writes it: the new owner of a card could not be woken, and the history says
--    why (a reason code, never card text). The caller must be able to post on the card's team, or be the system (the runtime's miss events).

ALTER TABLE app.task_events DROP CONSTRAINT task_events_type_check;
ALTER TABLE app.task_events ADD CONSTRAINT task_events_type_check
  CHECK (type IN ('created', 'claimed', 'released', 'state_changed', 'handed_off', 'completed', 'reworked', 'deployed', 'not_woken'));

DROP FUNCTION app.tasks_record_card(uuid, uuid);
CREATE FUNCTION app.tasks_record_card(p_handoff_id uuid, p_message_id uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor   uuid := app.actor();
  v_h       record;
  v_root    uuid;
  v_channel uuid;
  v_team    uuid;
BEGIN
  SELECT h.* INTO v_h FROM app.handoffs h WHERE h.id = p_handoff_id AND h.from_actor_id = v_actor AND h.card_message_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open handoff of yours with that id' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(m.thread_root_id, m.id), m.channel_id INTO v_root, v_channel
    FROM app.messages m
   WHERE m.id = p_message_id AND m.author_id = v_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that message is not yours' USING ERRCODE = '42501';
  END IF;
  SELECT c.team_id INTO v_team FROM app.channels c WHERE c.id = v_channel;
  IF v_team IS DISTINCT FROM v_h.team_id THEN
    RAISE EXCEPTION 'that message is in a channel outside the card''s team' USING ERRCODE = '42501';
  END IF;
  UPDATE app.handoffs SET card_message_id = p_message_id WHERE id = p_handoff_id;
  UPDATE app.tasks SET thread_root_id = v_root WHERE id = v_h.task_id AND thread_root_id IS NULL;
END
$$;

CREATE FUNCTION app.tasks_note_event(p_task_id uuid, p_type text, p_data jsonb) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_task record;
BEGIN
  IF p_type <> 'not_woken' THEN
    RAISE EXCEPTION 'only a not_woken line is written through this door' USING ERRCODE = '22023';
  END IF;
  SELECT t.id, t.team_id INTO v_task FROM app.tasks t
   WHERE t.id = p_task_id
     AND (session_user = 'manythreads_system' OR t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]));
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (v_task.id, v_task.team_id, NULL, 'not_woken', jsonb_build_object('reason', left(coalesce(p_data ->> 'reason', ''), 200)));
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_record_card(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_note_event(uuid, text, jsonb) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_record_card(uuid, uuid), app.tasks_note_event(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_record_card(uuid, uuid), app.tasks_note_event(uuid, text, jsonb) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.tasks_note_event(uuid, text, jsonb) IS 'Writes a not_woken line on a card''s history: a reason code, once per call.';
