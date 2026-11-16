-- approvals 0007 (P29): a push about an approval says where it was asked. Forward-only: never edit once applied.
--
-- `approvals_audience` told a push only the team and the people. A channel page that shows the questions waiting under its threads' roots must not read again for every
-- approval raised anywhere in the team, so the push now also names the channel and the thread root. The function's answer gets two more columns; the callers that read
-- `o_team_id` and `o_people` by name are not affected. The audience itself is unchanged.

DROP FUNCTION app.approvals_audience(uuid);
CREATE FUNCTION app.approvals_audience(p_approval_id uuid) RETURNS TABLE (o_team_id uuid, o_people uuid[], o_channel_id uuid, o_thread_root_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT ap.team_id,
         ARRAY(SELECT DISTINCT k.ref_id
                 FROM app.team_members tm
                 JOIN app.actors k ON k.id = tm.actor_id AND k.kind = 'person'
                WHERE tm.team_id = ap.team_id
                  AND (ap.channel_id IS NULL OR NOT coalesce(c.private, false)
                       OR k.ref_id IN (SELECT cm.person_id FROM app.channel_members cm WHERE cm.channel_id = ap.channel_id))),
         ap.channel_id,
         ap.thread_root_id
    FROM app.approvals ap
    LEFT JOIN app.channels c ON c.id = ap.channel_id
   WHERE ap.id = p_approval_id
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.approvals_audience(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.approvals_audience(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approvals_audience(uuid) TO manythreads_app, manythreads_system;
