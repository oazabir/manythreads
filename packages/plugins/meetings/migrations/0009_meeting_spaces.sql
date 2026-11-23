-- P36-03: meetings without a channel (docs/plans/meetings-without-a-channel.md). A meeting space is a team-less private channel of kind `meeting` whose
-- members are the person who made it and the people invited, from any team; its title is the channel's `purpose`. `app.meeting_spaces` keeps the team the
-- maker chose, which is where the notes and the transcript are kept (the channel itself has no team, so people of other teams can be in it).

CREATE TABLE app.meeting_spaces (
  channel_id   uuid PRIMARY KEY REFERENCES app.channels (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  team_id      uuid REFERENCES app.teams (id) ON DELETE SET NULL,
  created_by   uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_spaces_team ON app.meeting_spaces (team_id);
COMMENT ON TABLE app.meeting_spaces IS 'rls: workspace — C: the owning team of a meeting space (a channel of kind meeting): read by whoever reads the space; written only by app.meetings_open_space.';

ALTER TABLE app.meeting_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_spaces FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_spaces_select ON app.meeting_spaces FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY meeting_spaces_system ON app.meeting_spaces FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.meeting_spaces TO manythreads_app;

-- Opens a meeting space: the caller is a person on `p_team_id` (not a guest); everyone invited is an active member of the workspace who is not a guest; at
-- most 100 besides the caller. Returns the new channel.
CREATE FUNCTION app.meetings_open_space(p_title text, p_team_id uuid, p_person_ids uuid[]) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws      uuid := app.workspace_id();
  v_role    text := app.lookup_workspace_role();
  v_me      uuid;
  v_people  uuid[];
  v_channel uuid;
BEGIN
  SELECT a.ref_id INTO v_me FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = v_ws;
  IF v_me IS NULL OR v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'only members of the workspace can open a meeting' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                  WHERE tm.team_id = p_team_id AND a.ref_id = v_me) THEN
    RAISE EXCEPTION 'open a meeting for a team you are on' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF length(btrim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'a meeting needs a title of at most 120 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_people FROM unnest(coalesce(p_person_ids, '{}') || v_me) AS x;
  IF cardinality(v_people) > 101 THEN
    RAISE EXCEPTION 'a meeting invites at most 100 people' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (SELECT count(*) FROM app.people p JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id
       WHERE p.id = ANY (v_people) AND p.workspace_id = v_ws AND p.status = 'active' AND wm.role <> 'guest') <> cardinality(v_people) THEN
    RAISE EXCEPTION 'you can only invite active members of this workspace' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO app.channels (workspace_id, team_id, name, kind, private, purpose, created_by)
  VALUES (v_ws, NULL, '', 'meeting', true, left(btrim(p_title), 250), app.actor())
  RETURNING id INTO v_channel;
  INSERT INTO app.channel_members (channel_id, person_id) SELECT v_channel, p FROM unnest(v_people) AS p ON CONFLICT DO NOTHING;
  INSERT INTO app.meeting_spaces (channel_id, workspace_id, team_id, created_by) VALUES (v_channel, v_ws, p_team_id, app.actor());
  RETURN v_channel;
END
$$;

REVOKE ALL ON FUNCTION app.meetings_open_space(text, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_open_space(text, uuid, uuid[]) TO manythreads_app;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meetings_open_space(text, uuid, uuid[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
