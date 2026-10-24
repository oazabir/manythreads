-- bots 0014: the roster says which actor a bot is. A card's owner (and every history line) is an ACTOR id, and a bot's actor row is
-- not readable by a person (`actors_select` is own-row-only), so the roster cannot join it directly. This narrow definer function
-- returns (bot id, actor id) for the bots of ONE team, and only when the caller can read that team: it names nothing the roster did
-- not already list. Forward-only: never edit once applied.
CREATE FUNCTION app.team_bot_actor_ids(p_team_id uuid)
  RETURNS TABLE (bot_id uuid, actor_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF app.actor() IS NULL OR NOT (p_team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT b.id, a.id
    FROM app.bots b
    JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id AND a.workspace_id = b.workspace_id
   WHERE b.team_id = p_team_id AND b.workspace_id = app.workspace_id();
END
$$;
REVOKE ALL ON FUNCTION app.team_bot_actor_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.team_bot_actor_ids(uuid) TO manythreads_app;
-- Owned by the system role like the other definers: `actors_select` shows a person only their own row, and the explicit team check
-- above (readable_team_ids is evaluated for the caller's actor, not for the owner) is the gate.
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.team_bot_actor_ids(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
