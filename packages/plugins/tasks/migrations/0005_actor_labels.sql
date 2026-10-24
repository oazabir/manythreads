-- tasks plugin 0005: name the actors on a card for the `tasks.read` tool. A bot that reads "owner: <uuid>" cannot tell that uuid is its
-- own (live bug: a Reviewer read its own actor id as the Coder's and claimed a card it already held). The tool now writes the name next
-- to the id; this door resolves a list of actor ids to (kind, name, bot slug). `app.actors` shows a person only their own row, so the lookup
-- runs as the system role, like `tasks_actor_of`. It names only actors the caller can already see: the caller itself and the members (people
-- or bots) of a team the caller may read (the visibility set is hoisted once). Any other id returns no row. Forward-only: 0001 stays as applied.
CREATE FUNCTION app.tasks_actor_labels(p_actors uuid[])
  RETURNS TABLE (o_actor_id uuid, o_kind text, o_name text, o_slug text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT a.id, a.kind, coalesce(p.display_name, b.name, b.slug), b.slug
    FROM app.actors a
    LEFT JOIN app.people p ON p.id = a.ref_id AND a.kind = 'person'
    LEFT JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot'
   WHERE a.id = ANY (p_actors[1:200]) AND a.workspace_id = app.workspace_id()
     AND (a.id = app.actor()
          OR EXISTS (SELECT 1 FROM app.team_members tm
                      WHERE tm.actor_id = a.id AND tm.workspace_id = a.workspace_id
                        AND tm.team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])))
$$;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_actor_labels(uuid[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_actor_labels(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_actor_labels(uuid[]) TO manythreads_app, manythreads_system;
