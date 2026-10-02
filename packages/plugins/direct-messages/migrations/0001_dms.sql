-- direct-messages 0001: app.dms_get_or_create(), the one door that makes a DM channel (PLAN.md A.3 channels kind 'dm', P3-06).
-- Forward-only: never edit once applied. The tables are the channels plugin's (this plugin depends on it); no table here.
--
-- A DM is a private channel (kind 'dm', no team, name '') whose `dm_key` is the sorted person ids joined by ',', unique per workspace
-- (channels_dm_key, migration channels/0001). The channels policy never lets a caller insert one (only `kind = 'channel'`), so this
-- SECURITY DEFINER function, owned by manythreads_system, does it. Inside it app.is_system() is always true (MISTAKES P2 review): the
-- caller is checked with app.lookup_workspace_role() and the actor row, never the is_* helpers.
--
-- ONE STATEMENT. The channel and its members are written by one data-modifying CTE:
--   INSERT channel ... ON CONFLICT (workspace_id, dm_key) WHERE kind = 'dm' DO SELECT   -- the winner inserts, everyone else selects it
--   INSERT channel_members ... ON CONFLICT DO NOTHING                                    -- same statement, so no half-made DM exists
-- Concurrent opens of the same pair queue on the unique index; the loser's DO SELECT returns the winner's row once it commits.

CREATE FUNCTION app.dms_get_or_create(p_person_ids uuid[]) RETURNS TABLE (channel_id uuid, created boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws      uuid := app.workspace_id();
  v_role    text := app.lookup_workspace_role();
  v_me      uuid;
  v_people  uuid[];
  v_key     text;
  v_new     uuid := uuidv7();
  v_channel uuid;
BEGIN
  SELECT a.ref_id INTO v_me FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = v_ws;
  -- A guest's reach is the channels they were granted, and a bot is not a person: neither opens a DM.
  IF v_me IS NULL OR v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'only members of the workspace can send direct messages' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_person_ids IS NULL OR cardinality(p_person_ids) = 0 THEN
    RAISE EXCEPTION 'name at least one person' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_people FROM unnest(p_person_ids || v_me) AS x;
  IF cardinality(v_people) > 9 THEN
    RAISE EXCEPTION 'a conversation holds at most nine people' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Everyone must be an active member of this workspace and not a guest (a guest is reachable only inside a granted channel).
  IF (SELECT count(*) FROM app.people p JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id
       WHERE p.id = ANY (v_people) AND p.workspace_id = v_ws AND p.status = 'active' AND wm.role <> 'guest') <> cardinality(v_people) THEN
    RAISE EXCEPTION 'you can only message active members of this workspace' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_key := array_to_string(v_people, ',');
  WITH ch AS (
    INSERT INTO app.channels AS c (id, workspace_id, team_id, name, kind, private, dm_key, created_by)
    VALUES (v_new, v_ws, NULL, '', 'dm', true, v_key, app.actor())
    ON CONFLICT (workspace_id, dm_key) WHERE kind = 'dm' DO SELECT
    RETURNING c.id
  ), members AS (
    INSERT INTO app.channel_members (channel_id, person_id)
    SELECT ch.id, p FROM ch, unnest(v_people) AS p
    ON CONFLICT DO NOTHING
  )
  SELECT ch.id INTO v_channel FROM ch;
  RETURN QUERY SELECT v_channel, v_channel = v_new;
END
$$;

REVOKE ALL ON FUNCTION app.dms_get_or_create(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dms_get_or_create(uuid[]) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.dms_get_or_create(uuid[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
