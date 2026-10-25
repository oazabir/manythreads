-- tasks plugin 0006: a card a bot creates during a run is tied to the thread that run answers in. Forward-only: never edit once applied.
--
-- Until now a card got its thread (`thread_root_id`) only when it was handed over: the handover message became its root. An Orchestrator that
-- made several cards in one run and handed over just the first left the others without a thread, so when another bot finished one of them the
-- runtime had nowhere to wake the creator ("no_thread") and the Orchestrator never heard its cards were done.
--
-- app.tasks_link_run_thread(card) is called by the `tasks.create` tool right after the card is written. It is a convenience link, not a door
-- that grants anything, so it never raises: when any condition below fails it quietly does nothing. The conditions:
--   * the caller is a bot, and the current run (app.run_id()) is its own, still running;
--   * the run answers in a thread (`reply_root_id`), which resolves to its root message (not deleted);
--   * that message sits in an ordinary, not archived channel (not a direct message or a bot conversation) of the card's own team;
--   * the card was created by the caller and has no thread yet.
-- The check on the caller uses app.actor(), not the "system" test: inside a definer function app.is_system() is always true.
CREATE FUNCTION app.tasks_link_run_thread(p_task_id uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_root uuid;
BEGIN
  SELECT coalesce(m.thread_root_id, m.id) INTO v_root
    FROM app.bot_runs r
    JOIN app.actors bot ON bot.kind = 'bot' AND bot.ref_id = r.bot_id AND bot.workspace_id = r.workspace_id
    JOIN app.messages m ON m.id = r.reply_root_id AND m.workspace_id = r.workspace_id AND m.deleted_at IS NULL
    JOIN app.channels c ON c.id = m.channel_id AND c.kind = 'channel' AND c.archived_at IS NULL
    JOIN app.tasks t ON t.id = p_task_id AND t.team_id = c.team_id AND t.workspace_id = r.workspace_id
   WHERE r.id = app.run_id() AND r.status = 'running' AND r.ended_at IS NULL
     AND bot.id = app.actor()
     AND t.created_by = bot.id AND t.thread_root_id IS NULL;
  IF v_root IS NULL THEN RETURN; END IF;
  UPDATE app.tasks SET thread_root_id = v_root WHERE id = p_task_id AND thread_root_id IS NULL AND created_by = app.actor();
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_link_run_thread(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_link_run_thread(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_link_run_thread(uuid) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.tasks_link_run_thread(uuid) IS 'Ties a card its bot just created to the thread the bot''s current run answers in; does nothing when any condition fails.';
