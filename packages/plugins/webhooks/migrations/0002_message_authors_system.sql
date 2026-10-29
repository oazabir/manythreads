-- webhooks 0002: a webhook's own message names its author in the live push.
--
-- 0001 let the system role call app.message_authors, but inside it `app.visible_channel_ids('read')` is empty for the system role, so the
-- message a webhook posts was pushed live without its author (the channel showed "Someone" until it was reloaded). The system role now
-- names the authors of the messages it asks about; everyone else is as before.

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
  IF session_user = 'manythreads_system' THEN
    -- the system role has no person to read as: when a webhook posts, the message path runs as it and names the author of the message it
    -- pushes live; the messages asked for are the ones it just wrote, so every channel is in view
    v_visible := ARRAY(SELECT m.channel_id FROM app.messages m WHERE m.id = ANY (p_message_ids[1:500]));
  ELSE
    v_visible := app.visible_channel_ids('read');
  END IF;
  IF cardinality(v_visible) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.id,
         CASE a.kind
           WHEN 'person' THEN coalesce(p.display_name, 'Someone')
           WHEN 'bot' THEN coalesce(b.name, b.slug, 'Bot')
           ELSE coalesce(CASE WHEN w.emoji IS NULL THEN w.name ELSE w.emoji || ' ' || w.name END, 'System')
         END,
         a.kind
    FROM (SELECT DISTINCT m.author_id
            FROM app.messages m
           WHERE m.id = ANY (p_message_ids[1:500]) AND m.channel_id = ANY (v_visible)) x
    JOIN app.actors a ON a.id = x.author_id AND a.workspace_id = app.workspace_id()
    LEFT JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id AND p.workspace_id = a.workspace_id
    LEFT JOIN app.bots b ON a.kind = 'bot' AND b.id = a.ref_id AND b.workspace_id = a.workspace_id
    LEFT JOIN app.webhooks w ON a.kind = 'system' AND w.actor_id = a.id AND w.workspace_id = a.workspace_id;
END
$$;
