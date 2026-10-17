-- bots 0013: a bot is named by its own row (PLAN P5-05/P5-07). Forward-only: never edit once applied.
--
-- channels 0005 created `app.message_authors` with the comment "a bot and the system by a fixed label (the bots plugin gives bots a
-- name of their own later)". That is this migration: `app.bots.name` is the display name (the roster already draws it), and a bot's actor
-- row points at its bot row (`actors.ref_id = bots.id`), so the name is one LEFT JOIN away.
--
-- Same shape as channels 0005, deliberately: the function stays SECURITY DEFINER over `app.actor()`'s visible channels, so it still
-- names nobody but the authors of messages the caller can read; a bot of another team is named only inside a channel the caller reads,
-- and a bot whose row is gone (deleted) falls back to the old label. The join cannot widen anything the caller's own visibility did not
-- already allow: the channel list is the gate, and it is evaluated before any actor is looked up.
CREATE OR REPLACE FUNCTION app.message_authors(p_message_ids uuid[])
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
  SELECT a.id,
         CASE a.kind
           WHEN 'person' THEN coalesce(p.display_name, 'Someone')
           -- a bot's own name, and its slug when the row is not there to be named by
           WHEN 'bot' THEN coalesce(b.name, b.slug, 'Bot')
           ELSE 'System'
         END,
         a.kind
    FROM (SELECT DISTINCT m.author_id
            FROM app.messages m
           WHERE m.id = ANY (p_message_ids[1:500]) AND m.channel_id = ANY (v_visible)) w
    JOIN app.actors a ON a.id = w.author_id AND a.workspace_id = app.workspace_id()
    LEFT JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id AND p.workspace_id = a.workspace_id
    -- one row per (workspace, slug): the actor's ref_id can only be one bot, and (workspace_id, id) is the primary key
    LEFT JOIN app.bots b ON a.kind = 'bot' AND b.id = a.ref_id AND b.workspace_id = a.workspace_id;
END
$$;
-- the owner and the executable grant are unchanged from channels 0005; only the body is replaced (CREATE OR REPLACE keeps both).
