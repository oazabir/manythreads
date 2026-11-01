-- 0005_roster_avatar (P14-23): the roster carries each person's picture choice (`people.avatar`, kernel migration 0015). Forward-only: never edit once applied.
-- A new column in the result needs a new function: the old one is dropped and made again with the same body plus `avatar`.
DROP FUNCTION app.teams_roster(uuid);
CREATE FUNCTION app.teams_roster(p_team_id uuid)
  RETURNS TABLE (actor_id uuid, person_id uuid, display_name text, email text, workspace_role text, team_role text,
                 tags text[], joined_at timestamptz, avatar text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF session_user <> 'manythreads_system' AND NOT app.lookup_can('team', p_team_id, 'read') THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT tm.actor_id, p.id, p.display_name, p.primary_email, wm.role, tm.role,
         coalesce((
           SELECT array_agg(r.name ORDER BY r.name)
           FROM app.role_members rm
           JOIN app.team_role_tags trt ON trt.role_id = rm.role_id AND trt.team_id = tm.team_id
           JOIN app.roles r ON r.id = rm.role_id
           WHERE rm.person_id = p.id
         ), '{}'::text[]),
         tm.created_at,
         p.avatar
  FROM app.team_members tm
  JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
  JOIN app.people p ON p.id = a.ref_id
  JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id
  WHERE tm.team_id = p_team_id
  ORDER BY (tm.role = 'lead') DESC, lower(p.display_name), p.id;
END
$$;

REVOKE ALL ON FUNCTION app.teams_roster(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.teams_roster(uuid) TO manythreads_app, manythreads_system;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.teams_roster(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
