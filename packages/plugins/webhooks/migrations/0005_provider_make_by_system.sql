-- P16-10 fix to 0004: app.integrations_create_provider could not be called from a system transaction (the platform's own actor id is not a row of app.actors, so created_by
-- broke its foreign key). The route makes an endpoint and seals its signing secret in one system transaction after checking the caller itself, so the function now leaves
-- created_by empty in that case and the route fills it in. Everything else is as in 0004.
-- 0004 gave the function to the system role: take it back for the replacement, then hand it over again the way 0004 did.
ALTER FUNCTION app.integrations_create_provider(uuid, text, text, text, text, text[]) OWNER TO CURRENT_USER;
CREATE OR REPLACE FUNCTION app.integrations_create_provider(
  p_channel_id uuid, p_name text, p_emoji text, p_provider text, p_slug text, p_event_filter text[]
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws       uuid := app.workspace_id();
  v_caller   uuid := app.actor();
  v_team     uuid;
  v_archived timestamptz;
  v_id       uuid := uuidv7();
  v_actor    uuid;
  v_name     text;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    IF v_ws IS NULL OR v_caller IS NULL
       OR NOT EXISTS (SELECT 1 FROM app.actors a WHERE a.id = v_caller AND a.workspace_id = v_ws AND a.kind = 'person')
       OR NOT coalesce(app.lookup_channel_can(p_channel_id, 'manage'), false) THEN
      RAISE EXCEPTION 'only a lead of the channel''s team or a workspace admin can make an endpoint for an outside app' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT coalesce(app.lookup_channel_can(p_channel_id, 'read'), false) THEN
      RAISE EXCEPTION 'You can only make an endpoint for a channel you can read yourself. Join the channel first.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT c.team_id, c.archived_at, c.workspace_id INTO v_team, v_archived, v_ws
    FROM app.channels c WHERE c.id = p_channel_id AND c.kind = 'channel' AND c.team_id IS NOT NULL;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such channel' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'This channel is archived, so it cannot get an integration' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM app.webhooks w WHERE w.channel_id = p_channel_id AND w.revoked_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'A channel can have at most 20 webhooks, tokens and outgoing webhooks together. Switch one off that you no longer use.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.display_name INTO v_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id
   WHERE a.id = v_caller AND a.kind = 'person';
  -- Called by the platform itself (a system transaction, so that the sealed signing secret can be attached in the same step) the session's actor is the platform's own and
  -- not a row of app.actors: the maker is then recorded by the caller afterwards, and created_by stays empty here.
  IF v_name IS NULL AND NOT EXISTS (SELECT 1 FROM app.actors a WHERE a.id = v_caller) THEN
    v_caller := NULL;
  END IF;
  INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('system', v_ws, v_id) RETURNING id INTO v_actor;
  INSERT INTO app.webhooks (id, workspace_id, team_id, channel_id, actor_id, name, emoji, created_by, created_by_name, kind)
    VALUES (v_id, v_ws, v_team, p_channel_id, v_actor, p_name, NULLIF(p_emoji, ''), v_caller, v_name, 'provider');
  INSERT INTO app.webhook_provider (webhook_id, workspace_id, team_id, provider, slug, event_filter)
    VALUES (v_id, v_ws, v_team, p_provider, p_slug, coalesce(p_event_filter, ARRAY[]::text[]));
  RETURN v_id;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.integrations_create_provider(uuid, text, text, text, text, text[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.integrations_create_provider(uuid, text, text, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.integrations_create_provider(uuid, text, text, text, text, text[]) TO manythreads_app, manythreads_system;
