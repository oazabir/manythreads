-- tasks plugin 0011: the doors behind the `tasks.release` and `tasks.describe` tools. Forward-only: 0001 and 0010 stay as applied.
--
--  * `app.tasks_release` (replaced) no longer reopens a card that is finished (`done`) or that has a handover filed and not yet applied (a strict
--    handover waiting in Approvals: applying it does not look at who owns the card, so a release in between would hand a card away that its owner
--    no longer holds), for anyone. A BOT may not release a card that waits on a person (a pull request to merge, or a handover to a person): that
--    wait is a person's to end. A person (the board's release button) still may. The answers are `already_done`, `handoff_pending` and, for a
--    bot, `waiting_on_person`; the route turns any answer but `released` into a 409.
--  * `app.tasks_describe` (new) rewrites a card's description for the bot that owns it while its claim is live, with the same three refusals,
--    and writes a `described` line in the card's history (the lengths before and after and a sha256 of the new text, never the text itself).
--  * `task_events.type` gains `described`; the list is 0010's plus the new one.

ALTER TABLE app.task_events DROP CONSTRAINT task_events_type_check;
ALTER TABLE app.task_events ADD CONSTRAINT task_events_type_check
  CHECK (type IN ('created', 'claimed', 'released', 'state_changed', 'handed_off', 'completed', 'reworked', 'deployed', 'not_woken',
                  'pull_request_opened', 'pull_request_closed', 'described'));

CREATE OR REPLACE FUNCTION app.tasks_release(p_task_id uuid)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_bot   boolean;
BEGIN
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor
     AND NOT coalesce((SELECT app.lookup_can('team', v_task.team_id, 'manage')), false) THEN
    RETURN 'not_owner';
  END IF;
  IF v_task.state = 'done' THEN RETURN 'already_done'; END IF;
  -- this function is a definer owned by the system role, so it reads the caller's kind itself
  v_bot := coalesce((SELECT a.kind = 'bot' FROM app.actors a WHERE a.id = v_actor), false);
  IF v_bot AND v_task.state = 'waiting_on_person' THEN RETURN 'waiting_on_person'; END IF;
  IF EXISTS (SELECT 1 FROM app.handoffs h WHERE h.task_id = p_task_id AND h.applied_at IS NULL) THEN RETURN 'handoff_pending'; END IF;
  UPDATE app.task_claims SET released_at = now() WHERE task_id = p_task_id AND released_at IS NULL;
  UPDATE app.tasks SET owner_id = NULL, state = 'open', updated_at = now() WHERE id = p_task_id;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data) VALUES (p_task_id, v_task.team_id, v_actor, 'released', '{}'::jsonb);
  RETURN 'released';
END
$$;

-- Describe: only the owner, only while the claim is live and the card is still the owner's to work on.
CREATE FUNCTION app.tasks_describe(p_task_id uuid, p_description text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
BEGIN
  IF p_description IS NULL OR char_length(p_description) > 8000 THEN RETURN 'invalid_input'; END IF;
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor THEN RETURN 'not_owner'; END IF;
  IF v_task.state = 'done' THEN RETURN 'already_done'; END IF;
  IF v_task.state = 'waiting_on_person' THEN RETURN 'waiting_on_person'; END IF;
  IF EXISTS (SELECT 1 FROM app.handoffs h WHERE h.task_id = p_task_id AND h.applied_at IS NULL) THEN RETURN 'handoff_pending'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.task_claims c WHERE c.task_id = p_task_id AND c.actor_id = v_actor AND c.released_at IS NULL AND c.expires_at > now()) THEN
    RETURN 'claim_expired';
  END IF;
  UPDATE app.tasks SET description = p_description, updated_at = now() WHERE id = p_task_id;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'described',
          jsonb_build_object('beforeLength', char_length(v_task.description), 'afterLength', char_length(p_description),
                             'sha256', encode(sha256(convert_to(p_description, 'UTF8')), 'hex')));
  RETURN 'described';
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_describe(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_describe(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_describe(uuid, text) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.tasks_describe(uuid, text) IS 'Rewrites the description of a card the caller owns, while the claim is live; writes a described line (lengths and a hash).';
