-- memory-hindsight 0003 (P20-05): the door through which a run finds a person's own memory bank. Forward-only: never edit once applied.
--
-- A person has one bank of their own, `person:<workspace slug>:<person id>`, beside each team's. A run reaches it only when the database says the run
-- may use that person's Personal space right now: the run answers the person inside their own private context (a conversation with a bot, a DM) AND
-- the bot is the workspace Brain or asks for `personal.read` in its definition AND the person has not said no (`app.run_space_context()`, bots 0026).
-- The answer is derived from the run's own row, never from anything a bot sends, so a bot cannot name a person's bank, and it is asked again on every
-- call, so a withdrawn yes ends the next call.
--
--  * `person_id`        the asker, when their Personal space is open to this run; null otherwise (no bank).
--  * `workspace_slug`   what the bank is named from.
--
-- The function answers only for the transaction's own live run (like `app.memory_run_scope()`, 0001), by asking the bots plugin's function that
-- already checks that. Inside, `app.is_system()` is TRUE, so nothing here uses it.

CREATE FUNCTION app.memory_run_person()
  RETURNS TABLE (run_id uuid, workspace_slug text, person_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT c.run_id, w.slug, c.asker_person_id
    FROM app.run_space_context() c
    JOIN app.workspaces w ON w.id = c.workspace_id
   WHERE c.personal_allowed AND c.asker_person_id IS NOT NULL;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.memory_run_person() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.memory_run_person() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_run_person() TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.memory_run_person() IS
  'The person whose own memory bank the calling transaction''s live run may use right now (their Personal space is open to this bot), with the workspace slug the bank is named from. No row when it may not, and none for any other transaction.';
