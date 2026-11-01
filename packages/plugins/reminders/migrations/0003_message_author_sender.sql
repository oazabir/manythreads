-- reminders 0003: say which kind of system sender wrote a message (PLAN P14-02, follow-up to P14-04). Forward-only: never edit once applied.
--
-- `app.message_authors` gives a webhook and the "Reminders" sender the same actor kind (`system`); the web client told them apart by the NAME, so a webhook
-- that its admin called "Reminders" was badged as the platform's own sender. The function now says it outright in a fourth column, `sender`:
--   'reminders'  the workspace's reminder sender (a row of app.reminder_senders)
--   'webhook'    an incoming webhook's actor (a row of app.webhooks)
--   NULL         a person, a bot, or a system actor that is neither
-- A column cannot be added with CREATE OR REPLACE, so the function is dropped and made again: the same body as reminders 0002 plus the column, the same
-- definer rights, and the same two grants (nobody else may call it). Nothing else depends on it (every caller names the columns it reads).
DROP FUNCTION app.message_authors(uuid[]);

CREATE FUNCTION app.message_authors(p_message_ids uuid[])
  RETURNS TABLE (actor_id uuid, display_name text, kind text, sender text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_visible uuid[];
BEGIN
  IF p_message_ids IS NULL OR cardinality(p_message_ids) = 0 OR app.actor() IS NULL THEN
    RETURN;
  END IF;
  IF session_user = 'manythreads_system' THEN
    -- the system role has no person to read as: when a webhook or the reminders job posts, the message path runs as it and names the author of the
    -- message it pushes live; the messages asked for are the ones it just wrote, so every channel is in view
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
           ELSE coalesce(CASE WHEN w.emoji IS NULL THEN w.name ELSE w.emoji || ' ' || w.name END,
                         CASE WHEN rs.actor_id IS NOT NULL THEN 'Reminders' END,
                         'System')
         END,
         a.kind,
         CASE WHEN a.kind <> 'system' THEN NULL WHEN rs.actor_id IS NOT NULL THEN 'reminders' WHEN w.actor_id IS NOT NULL THEN 'webhook' END
    FROM (SELECT DISTINCT m.author_id
            FROM app.messages m
           WHERE m.id = ANY (p_message_ids[1:500]) AND m.channel_id = ANY (v_visible)) x
    JOIN app.actors a ON a.id = x.author_id AND a.workspace_id = app.workspace_id()
    LEFT JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id AND p.workspace_id = a.workspace_id
    LEFT JOIN app.bots b ON a.kind = 'bot' AND b.id = a.ref_id AND b.workspace_id = a.workspace_id
    LEFT JOIN app.webhooks w ON a.kind = 'system' AND w.actor_id = a.id AND w.workspace_id = a.workspace_id
    LEFT JOIN app.reminder_senders rs ON a.kind = 'system' AND rs.actor_id = a.id AND rs.workspace_id = a.workspace_id;
END
$$;
REVOKE ALL ON FUNCTION app.message_authors(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.message_authors(uuid[]) TO manythreads_app, manythreads_system;
