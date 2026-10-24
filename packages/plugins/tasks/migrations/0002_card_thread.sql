-- tasks plugin 0002: the card's thread, and the message that announced a handover. Forward-only: never edit once applied.
--
--  * handoffs.card_message_id: the channel message the handover posted in the card's thread ("Orchestrator → @coder: <note>").
--    The bot router reads it to know that this message is the announcement of an assignment, not a request of its own, so
--    one assignment starts one run (the assignment's own event starts it) and the @mention in the announcement starts none.
--  * app.tasks_record_card(handoff, message): the caller (the handover's sender) names the message it just posted; the door
--    checks that the sender wrote it, stores it on the handoff and, when the card had no thread yet, makes that message the
--    card's thread root (tasks.thread_root_id, which nothing set until now).

ALTER TABLE app.handoffs ADD COLUMN card_message_id uuid;
CREATE INDEX handoffs_card_message ON app.handoffs (card_message_id) WHERE card_message_id IS NOT NULL;

CREATE FUNCTION app.tasks_record_card(p_handoff_id uuid, p_message_id uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_h     record;
  v_root  uuid;
BEGIN
  SELECT h.* INTO v_h FROM app.handoffs h WHERE h.id = p_handoff_id AND h.from_actor_id = v_actor AND h.card_message_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(m.thread_root_id, m.id) INTO v_root
    FROM app.messages m
   WHERE m.id = p_message_id AND m.author_id = v_actor;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE app.handoffs SET card_message_id = p_message_id WHERE id = p_handoff_id;
  UPDATE app.tasks SET thread_root_id = v_root WHERE id = v_h.task_id AND thread_root_id IS NULL;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_record_card(uuid, uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_record_card(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_record_card(uuid, uuid) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.tasks_record_card(uuid, uuid) IS
  'The handover sender names the message it posted in the card thread: stored on the handoff, and the card''s thread root when it had none.';
