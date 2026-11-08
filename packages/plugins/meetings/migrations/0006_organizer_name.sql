-- meetings 0006: a reader of a planned room sees who organizes it (integration pass of Bundle D). Forward-only: never edit once applied.
--
-- The plan's routes read the organizer's name with a sub-select over app.actors, but a person sees only their own row of `actors` (policy `actors_select`), so everyone except the
-- organizer read "Organized by a former member" on the header chip and on the join page. This function answers the one name, as the system role does inside a definer function, and only
-- to a member of the same workspace (the rule `people_select` already applies to the people table: a guest is not told).
CREATE FUNCTION app.meetings_organizer_name(p_actor_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT p.display_name
    FROM app.actors a
    JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id
   WHERE a.id = p_actor_id AND a.kind = 'person'
     AND a.workspace_id = app.workspace_id()
     AND coalesce(app.lookup_workspace_role(), 'guest') IN ('owner', 'admin', 'member')
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meetings_organizer_name(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.meetings_organizer_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_organizer_name(uuid) TO manythreads_app, manythreads_system;
