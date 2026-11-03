-- surfaces 0002: what the three tools (`surface.render`, `surface.update`, `surface.event`) need to know without trusting the model (PLAN P9-04). Forward-only.
--
-- Two read-only helper functions, both SECURITY DEFINER and answering only for the live run of the calling bot. They add no table and widen no policy.
--
--   app.surface_run_context()   where the calling run draws: its bot, its channel and the thread it answers in. A bot cannot read its own run row under the row
--                               level security of `bot_runs`, and a tool must never take the channel or the thread from the model, so the platform reads them
--                               here. Same shape as `app.memory_run_context()`: no row unless app.actor() is the bot of a run that is running right now.
--   app.surface_pending_events() the clicks and forms people sent back to a surface of the calling bot that it has not answered yet, oldest first, with the
--                               name of the person. "Not answered yet" means after the surface's last `render` or `update` line: changing the screen is the
--                               answer. Only the owning bot sees them, and only while it can still read the channel (a bot taken out of a private channel
--                               reads nothing more from it).

CREATE FUNCTION app.surface_run_context()
  RETURNS TABLE (run_id uuid, bot_id uuid, workspace_id uuid, team_id uuid, channel_id uuid, reply_root_id uuid, channel_kind text, channel_private boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT r.id, r.bot_id, r.workspace_id, r.team_id, r.channel_id, r.reply_root_id, c.kind, c.private
    FROM app.bot_runs r
    JOIN app.actors bot_actor ON bot_actor.kind = 'bot' AND bot_actor.ref_id = r.bot_id AND bot_actor.workspace_id = r.workspace_id
    LEFT JOIN app.channels c ON c.id = r.channel_id AND c.workspace_id = r.workspace_id
   WHERE r.id = app.run_id()
     AND r.status = 'running'
     AND r.ended_at IS NULL
     AND app.actor() = bot_actor.id;
$$;

CREATE FUNCTION app.surface_pending_events(p_surface uuid, p_after uuid, p_limit integer)
  RETURNS TABLE (id uuid, surface_id uuid, surface_title text, version integer, node_id text, payload jsonb, created_at timestamptz, actor_id uuid, person_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT e.id, s.id, s.title, e.version, e.node_id, e.payload, e.created_at, e.actor_id, p.display_name
    FROM app.surface_run_context() me
    JOIN app.surfaces s ON s.bot_id = me.bot_id AND s.workspace_id = me.workspace_id
                       AND CASE WHEN p_surface IS NULL THEN s.channel_id = me.channel_id ELSE s.id = p_surface END
    JOIN app.surface_events e ON e.surface_id = s.id AND e.kind = 'event'
    LEFT JOIN app.actors a ON a.id = e.actor_id AND a.kind = 'person'
    LEFT JOIN app.people p ON p.id = a.ref_id
   WHERE coalesce(app.lookup_channel_can(s.channel_id, 'read'), false)
     AND e.id > greatest(
           coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid),
           coalesce((SELECT b.id FROM app.surface_events b WHERE b.surface_id = s.id AND b.kind IN ('render', 'update') ORDER BY b.id DESC LIMIT 1), '00000000-0000-0000-0000-000000000000'::uuid))
   ORDER BY e.id
   LIMIT least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

-- as in 0001: the definer functions run as the system role, so they pass the system policies (and only those)
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.surface_run_context() OWNER TO manythreads_system;
ALTER FUNCTION app.surface_pending_events(uuid, uuid, integer) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.surface_run_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.surface_pending_events(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.surface_run_context() TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.surface_pending_events(uuid, uuid, integer) TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.surface_run_context() IS 'Where the calling transaction''s live run draws (app.run_id(), set only by withActor): its bot, workspace, team, channel and the message its reply hangs from. One row, only when app.actor() is that run''s bot; none otherwise.';
COMMENT ON FUNCTION app.surface_pending_events(uuid, uuid, integer) IS 'The events people sent back to surfaces of the calling bot (one surface, or those it drew in the run''s channel) that it has not answered with a render or update, oldest first, with the person''s name. Only for the live run of the owning bot, and only while that bot can read the channel.';
