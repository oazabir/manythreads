-- channels 0008: app.channel_actor_can_post(actor, channel) — whether ANOTHER actor may post in a channel. Forward-only: never edit once applied.
--
-- app.visible_channel_ids answers for the caller. A plugin that hands work from one actor to another (a task handed to a bot) needs the
-- question for the other one, from code that is not allowed to set session settings. The rule is not copied: the function evaluates
-- app.visible_channel_ids('post') with the other actor's id in place for one statement and puts the caller's back. The caller must be able to
-- read the channel itself (or be the system), so the answer cannot be used to probe channels the caller does not see; an actor of another
-- workspace answers false.

CREATE FUNCTION app.channel_actor_can_post(p_actor_id uuid, p_channel_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_prev text := coalesce(current_setting('app.actor_id', true), '');
  v_ok   boolean;
BEGIN
  IF session_user <> 'manythreads_system' AND NOT (p_channel_id = ANY (app.visible_channel_ids('read'))) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.actors a WHERE a.id = p_actor_id AND a.workspace_id = app.workspace_id()) THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.actor_id', p_actor_id::text, true);
  v_ok := p_channel_id = ANY (app.visible_channel_ids('post'));
  PERFORM set_config('app.actor_id', NULLIF(v_prev, ''), true);  -- app.actor() reads '' as NULL too; this keeps "unset" unset
  RETURN coalesce(v_ok, false);
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.channel_actor_can_post(uuid, uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.channel_actor_can_post(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.channel_actor_can_post(uuid, uuid) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.channel_actor_can_post(uuid, uuid) IS
  'Whether the actor may post in the channel (app.visible_channel_ids evaluated for that actor); only for a channel the caller can read.';
