-- channels 0005: who wrote a message. Forward-only: never edit once applied.
--
-- `people` and `actors` show a caller only their own row (RLS), and a guest has no roster, so the web client could not turn a message's
-- `author_id` into a name ("Someone"). This definer function answers names for the authors of the messages the caller can read, and
-- for nobody else: the message ids are joined to the caller's readable channels (`app.visible_channel_ids('read')`, evaluated for the
-- caller because the actor lives in a session setting) before any actor is looked up. Passing an id of a message in a channel the caller
-- cannot read, a made-up id or an actor id returns nothing; at most 500 ids are looked at. A person is named by their display name, a bot
-- and the system by a fixed label (the bots plugin gives bots a name of their own later).
CREATE FUNCTION app.message_authors(p_message_ids uuid[])
  RETURNS TABLE (actor_id uuid, display_name text, kind text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_visible uuid[];
BEGIN
  IF p_message_ids IS NULL OR cardinality(p_message_ids) = 0 OR app.actor() IS NULL THEN
    RETURN;
  END IF;
  v_visible := app.visible_channel_ids('read');
  IF cardinality(v_visible) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.id, CASE a.kind WHEN 'person' THEN coalesce(p.display_name, 'Someone') WHEN 'bot' THEN 'Bot' ELSE 'System' END, a.kind
    FROM (SELECT DISTINCT m.author_id
            FROM app.messages m
           WHERE m.id = ANY (p_message_ids[1:500]) AND m.channel_id = ANY (v_visible)) w
    JOIN app.actors a ON a.id = w.author_id AND a.workspace_id = app.workspace_id()
    LEFT JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id AND p.workspace_id = a.workspace_id;
END
$$;
REVOKE ALL ON FUNCTION app.message_authors(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.message_authors(uuid[]) TO manythreads_app;
