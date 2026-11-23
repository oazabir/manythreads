-- Incidents (P35-07, P18-07). `/incident <title>` opens a channel `#inc-<yyyymmdd>-<slug>` in the team for the incident, with its opening message (which
-- names @on-call, so the role group is paged by the ordinary mention path); the team's alert-triage bot is woken in that message's thread to gather logs
-- and a timeline, and again on the incident's rhythm for a status update; `/incident resolve` closes it and drafts the post-mortem page.
--
-- Any member of the team may open one (a lead is not needed to start an incident), so the channel is made by a definer function that checks that the
-- caller is a person on the team who is not a guest; everything after that (the opening message, the push, the event) is the caller's own, as for any
-- channel. Rows are read with their channel and written only by the functions below and by the system role (the status rhythm).

CREATE TABLE app.incidents (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id         uuid NOT NULL,
  team_id              uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  channel_id           uuid NOT NULL UNIQUE REFERENCES app.channels (id) ON DELETE CASCADE,
  title                text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  opened_by            uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  root_message_id      uuid REFERENCES app.messages (id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  update_every_minutes integer NOT NULL DEFAULT 30 CHECK (update_every_minutes BETWEEN 5 AND 240),
  next_update_at       timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  opened_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  resolved_by          uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  summary              text CHECK (summary IS NULL OR length(summary) <= 2000),
  postmortem_path      text CHECK (postmortem_path IS NULL OR length(postmortem_path) <= 300),
  CONSTRAINT incidents_resolved_shape CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX incidents_team_opened ON app.incidents (team_id, opened_at DESC);
CREATE INDEX incidents_open_due ON app.incidents (next_update_at) WHERE status = 'open';
COMMENT ON TABLE app.incidents IS 'rls: team — C: an incident of a team (P35-07): read with its channel; opened, given its opening message and resolved through the definer functions app.incidents_open, app.incidents_set_root and app.incidents_resolve; the status rhythm is moved by the system role.';

-- Opens an incident: the channel (in the team's "Incidents" group, made on first use), the caller as its first member, and the incident row. The name is
-- `p_name`, or `p_name-2`, `-3`… when a channel of that name exists. Returns the channel and the incident.
CREATE FUNCTION app.incidents_open(p_team_id uuid, p_name text, p_title text) RETURNS TABLE (channel_id uuid, incident_id uuid, name text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws      uuid;
  v_person  uuid;
  v_group   uuid;
  v_name    text;
  v_channel uuid;
  v_inc     uuid;
  v_n       integer := 1;
BEGIN
  IF app.actor() IS NULL OR NOT coalesce(app.lookup_can_team(p_team_id, 'post'), false) OR coalesce(app.workspace_role(), '') = 'guest' THEN
    RAISE EXCEPTION 'only a member of the team can open an incident' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT a.ref_id INTO v_person FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person';
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'only a person can open an incident' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_name !~ '^[a-z0-9][a-z0-9-]{0,55}$' OR length(btrim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'bad incident name or title' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.workspace_id INTO v_ws FROM app.teams t WHERE t.id = p_team_id AND t.archived_at IS NULL;
  IF v_ws IS NULL OR v_ws <> app.workspace_id() THEN
    RAISE EXCEPTION 'no such team' USING ERRCODE = 'foreign_key_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('channels.incident:' || p_team_id::text, 0));
  INSERT INTO app.channel_groups (workspace_id, team_id, name, position)
  VALUES (v_ws, p_team_id, 'Incidents', (SELECT coalesce(max(g.position), 0) + 1 FROM app.channel_groups g WHERE g.team_id = p_team_id))
  ON CONFLICT (team_id, name) DO NOTHING;
  SELECT g.id INTO v_group FROM app.channel_groups g WHERE g.team_id = p_team_id AND g.name = 'Incidents';
  v_name := p_name;
  WHILE EXISTS (SELECT 1 FROM app.channels c WHERE c.team_id = p_team_id AND c.name = v_name AND c.kind = 'channel') LOOP
    v_n := v_n + 1;
    v_name := p_name || '-' || v_n::text;
    IF v_n > 50 THEN
      RAISE EXCEPTION 'too many incidents with this name today' USING ERRCODE = 'unique_violation';
    END IF;
  END LOOP;
  INSERT INTO app.channels (workspace_id, team_id, group_id, name, kind, private, purpose, position, created_by)
  VALUES (v_ws, p_team_id, v_group, v_name, 'channel', false, left('Incident: ' || btrim(p_title), 250),
          (SELECT coalesce(max(c.position), 0) + 1 FROM app.channels c WHERE c.team_id = p_team_id), app.actor())
  RETURNING id INTO v_channel;
  INSERT INTO app.channel_members (channel_id, person_id) VALUES (v_channel, v_person) ON CONFLICT DO NOTHING;
  INSERT INTO app.incidents (workspace_id, team_id, channel_id, title, opened_by)
  VALUES (v_ws, p_team_id, v_channel, btrim(p_title), app.actor())
  RETURNING id INTO v_inc;
  RETURN QUERY SELECT v_channel, v_inc, v_name;
END
$$;

-- The opening message, once, by the person who opened the incident.
CREATE FUNCTION app.incidents_set_root(p_incident_id uuid, p_message_id uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.incidents i SET root_message_id = p_message_id
   WHERE i.id = p_incident_id AND i.opened_by = app.actor() AND i.root_message_id IS NULL AND i.workspace_id = app.workspace_id()
     AND EXISTS (SELECT 1 FROM app.messages m WHERE m.id = p_message_id AND m.channel_id = i.channel_id AND m.author_id = app.actor());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not the opener of this incident, or its opening message is set' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;

-- Resolves the incident of a channel: anyone who may post in the channel (the person running it, a responder). False when it was already resolved.
CREATE FUNCTION app.incidents_resolve(p_channel_id uuid, p_summary text, p_postmortem_path text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF app.actor() IS NULL OR NOT p_channel_id = ANY (app.visible_channel_ids('post')) OR coalesce(app.workspace_role(), '') = 'guest' THEN
    RAISE EXCEPTION 'only someone who can post in the incident channel can resolve it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT i.id INTO v_id FROM app.incidents i WHERE i.channel_id = p_channel_id AND i.workspace_id = app.workspace_id() FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'this channel has no incident' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE app.incidents SET status = 'resolved', resolved_at = now(), resolved_by = app.actor(), summary = nullif(left(btrim(coalesce(p_summary, '')), 2000), ''),
                           postmortem_path = p_postmortem_path
   WHERE id = v_id AND status = 'open';
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION app.incidents_open(uuid, text, text), app.incidents_set_root(uuid, uuid), app.incidents_resolve(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.incidents_open(uuid, text, text), app.incidents_set_root(uuid, uuid), app.incidents_resolve(uuid, text, text) TO manythreads_app;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.incidents_open(uuid, text, text) OWNER TO manythreads_system;
ALTER FUNCTION app.incidents_set_root(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.incidents_resolve(uuid, text, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

ALTER TABLE app.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY incidents_select ON app.incidents FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY incidents_system ON app.incidents FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.incidents TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.incidents TO manythreads_system;
