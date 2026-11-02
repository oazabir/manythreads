-- tasks plugin 0014: the door behind the board's checklist boxes (PLAN P14-19). Forward-only: 0001 and 0011 stay as applied.
--
--  * `app.tasks_tick` writes a card's description with one `- [ ]` / `- [x]` box changed, for a PERSON who can post in the card's team. The route works
--    the new text out (the same one-character rule the chat uses); this door only checks that the description is still exactly the text that rule was
--    applied to (`p_expected`), so two people ticking at once, or a bot rewriting the list meanwhile, never lose each other's edit: the loser gets `changed`
--    and reads the card again.
--  * A bot does not use it: a bot rewrites a description with `tasks_describe`, which needs the claim. A finished card (`done`) is not changed.
--  * The card's history gets a `described` line, like the bot's rewrite, with `data.tick` = { nth, checked } added; the lengths and the sha256 are of the
--    new text, never the text itself.

CREATE FUNCTION app.tasks_tick(p_task_id uuid, p_expected text, p_description text, p_nth integer, p_checked boolean)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
BEGIN
  IF p_description IS NULL OR p_expected IS NULL OR char_length(p_description) > 8000 OR p_nth IS NULL OR p_nth < 0 OR p_checked IS NULL THEN
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

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_tick(uuid, text, text, integer, boolean) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_tick(uuid, text, text, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_tick(uuid, text, text, integer, boolean) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.tasks_tick(uuid, text, text, integer, boolean) IS 'Writes a card description with one checklist box changed, for a person who can post in the team; compare-and-set on the old text; writes a described line with the tick.';
