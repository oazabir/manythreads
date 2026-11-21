-- tasks plugin 0019: a card's description may be 32000 characters (was 8000; P31-03, 2026-11-21). Each bot of the Engineering chain adds its own
-- `## <role> · round N` section to the card, and on a live delivery the Committer, the last bot, found no room left for its section. The table's check
-- and the two doors that write the text (`tasks_describe`, 0011; `tasks_tick`, 0014) say the same number as `TASK_DESCRIPTION_MAX` in @manythreads/shared.
-- Forward-only; the functions keep their signatures, owners and grants (CREATE OR REPLACE), only the length changes.

ALTER TABLE app.tasks DROP CONSTRAINT tasks_description_check;
ALTER TABLE app.tasks ADD CONSTRAINT tasks_description_check CHECK (char_length(description) <= 32000);

CREATE OR REPLACE FUNCTION app.tasks_describe(p_task_id uuid, p_description text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
BEGIN
  IF p_description IS NULL OR char_length(p_description) > 32000 THEN RETURN 'invalid_input'; END IF;
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

CREATE OR REPLACE FUNCTION app.tasks_tick(p_task_id uuid, p_expected text, p_description text, p_nth integer, p_checked boolean)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
BEGIN
  IF p_description IS NULL OR p_expected IS NULL OR char_length(p_description) > 32000 OR p_nth IS NULL OR p_nth < 0 OR p_checked IS NULL THEN
    RETURN 'invalid_input';
  END IF;
  -- this function is a definer owned by the system role, so it reads the caller's kind itself
  IF NOT coalesce((SELECT a.kind = 'person' FROM app.actors a WHERE a.id = v_actor), false) THEN RETURN 'not_person'; END IF;
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_task.state = 'done' THEN RETURN 'already_done'; END IF;
  IF v_task.description IS DISTINCT FROM p_expected THEN RETURN 'changed'; END IF;
  IF p_description = v_task.description THEN RETURN 'ticked'; END IF;
  UPDATE app.tasks SET description = p_description, updated_at = now() WHERE id = p_task_id;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'described',
          jsonb_build_object('beforeLength', char_length(v_task.description), 'afterLength', char_length(p_description),
                             'sha256', encode(sha256(convert_to(p_description, 'UTF8')), 'hex'),
                             'tick', jsonb_build_object('nth', p_nth, 'checked', p_checked)));
  RETURN 'ticked';
END
$$;
