-- channels 0012: app.channel_role_audience(channel, people) — which of these people a mention of a role group reaches in this channel (P14-03).
-- Forward-only: never edit once applied.
--
-- A role group (a TEAM.md role tag used as `@on-call`) names people by the tag they hold; the teams plugin says who holds it. Whether each of
-- them is told is the channel's rule, not the tag's: only people who can read this channel (a private channel or a direct message leaves out
-- team members who are not in it), who are active, and have an actor. The caller must be able to read the channel and must not be a guest,
-- the same door as app.channel_mention_candidates, so the answer is never a way to learn who sits in a channel the caller cannot read; a
-- caller who may read the channel learns only which of the people they already named hold a seat in it. Returns nothing for a channel the
-- caller cannot read.

CREATE FUNCTION app.channel_role_audience(p_channel_id uuid, p_person_ids uuid[])
  RETURNS TABLE (person_id uuid, actor_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_person_ids IS NULL OR cardinality(p_person_ids) = 0 THEN
    RETURN;
  END IF;
  IF session_user <> 'manythreads_system' AND (
       NOT coalesce(app.lookup_channel_can(p_channel_id, 'read'), false)
       OR coalesce(app.lookup_workspace_role(), 'guest') = 'guest') THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT p.id, a.id
    FROM app.channel_audience(p_channel_id) au
    JOIN app.people p ON p.id = au.person_id AND p.status = 'active'
    JOIN app.actors a ON a.kind = 'person' AND a.ref_id = p.id AND a.workspace_id = p.workspace_id
   WHERE au.person_id = ANY (p_person_ids)
   ORDER BY p.id;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.channel_role_audience(uuid, uuid[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.channel_role_audience(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.channel_role_audience(uuid, uuid[]) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.channel_role_audience(uuid, uuid[]) IS
  'Which of the given people (a role group''s holders) can read the channel; only for a non-guest caller who can read it.';
