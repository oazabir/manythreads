-- P17-06: `knowledge.search` of the workspace Brain. `app.knowledge_run_grant()` (0001) answered the BOT's own `team_id`, and the workspace Brain has none (bots 0027),
-- so every knowledge search of a Brain run was refused before it looked ("teamId: expected string, received null"; seen live on a meeting run on 2026-11-25). A
-- workspace bot's run keeps its CONTEXT team on the run's own row (`bot_runs.team_id`: the team of the channel, the conversation or the call it answers in), the team
-- every other read of that run is held to (`app.run_space_context`), so that team is the answer for a bot with no team of its own. A team bot is unchanged.
CREATE OR REPLACE FUNCTION app.knowledge_run_grant() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE r record;
BEGIN
  SELECT b.id AS bot_id, coalesce(b.team_id, br.team_id) AS team_id, b.knowledge INTO r
    FROM app.bot_runs br JOIN app.bots b ON b.id = br.bot_id
   WHERE br.id = app.run_id() AND br.status = 'running' AND br.ended_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('botId', r.bot_id, 'teamId', r.team_id, 'knowledge', r.knowledge);
END
$$;
REVOKE ALL ON FUNCTION app.knowledge_run_grant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.knowledge_run_grant() TO manythreads_app, manythreads_system;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.knowledge_run_grant() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
