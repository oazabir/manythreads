-- meetings 0008: people asked to a call (PLAN P15-27, docs/plans/calls-card.md step S4). Forward-only: never edit once applied.
--
-- An invitation says who is told about a live call: the person gets an inbox item and a push (the notifications plugin, from `meetings.invite.sent`). It decides who is
-- told, not who may join: whoever can read the channel may join, invited or not. Only people who can read the call's channel can be asked.
--
--   meeting_invites       one row per call and person asked: the name copied when asked (a reader who cannot read `people` still sees it on the card), who asked, when.
--                         Readable by whoever reads the channel; written only by app.meetings_invite (below) and the system role.
--   meetings (id, channel_id)  a unique key, so an invitation's channel is the call's own channel (a composite foreign key, as the attendees of a planned room have).

ALTER TABLE app.meetings ADD CONSTRAINT meetings_id_channel UNIQUE (id, channel_id);

CREATE TABLE app.meeting_invites (
  meeting_id   uuid NOT NULL,
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  -- copied from the person when asked, so the card can name the people asked without reading `people`
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  invited_by   uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  invited_at   timestamptz NOT NULL DEFAULT now(),
  -- copied from the call, so the policy probes the visibility set without reading the call
  channel_id   uuid NOT NULL,
  team_id      uuid REFERENCES app.teams (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, person_id),
  FOREIGN KEY (meeting_id, channel_id) REFERENCES app.meetings (id, channel_id) ON DELETE CASCADE
);
CREATE INDEX meeting_invites_person ON app.meeting_invites (person_id);
CREATE INDEX meeting_invites_invited_by ON app.meeting_invites (invited_by);
CREATE INDEX meeting_invites_channel ON app.meeting_invites (channel_id);
CREATE INDEX meeting_invites_team ON app.meeting_invites (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX meeting_invites_workspace ON app.meeting_invites (workspace_id);
COMMENT ON TABLE app.meeting_invites IS 'rls: team — C: the people asked to a call, readable by whoever reads its channel (app.visible_channel_ids); written only through app.meetings_invite and the system role.';

-- Ask people to a call ----------------------------------------------------------------------------------------------------------------------------------
-- A definer function owned by the system role: inside it `app.is_system()` is always true, so the caller is checked by `session_user` and by the caller's own rights
-- (`app.lookup_channel_can` reads the actor of the request, MISTAKES P2 review). The caller must be a person who may post in the call's channel, and the call must be live
-- and have a channel that is not a direct message. Every id must be a person who can read the channel now; when one cannot, the whole list is refused (nothing is written) instead of quietly asking
-- the rest. At most 100 ids in one call. The caller and the people asked before are left out. Returns the people newly asked.
CREATE FUNCTION app.meetings_invite(p_meeting_id uuid, p_person_ids uuid[]) RETURNS uuid[]
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m          record;
  v_ws       uuid := app.workspace_id();
  v_caller   uuid := app.actor();
  v_me       uuid := app.person_id();
  -- a system caller is not supported by the routes (no actor to name as `invited_by`, no event); the branch only keeps the function from failing for one
  v_system   boolean := session_user = 'manythreads_system';
  v_ids      uuid[];
  v_outside  integer;
  v_new      uuid[];
BEGIN
  IF NOT v_system AND (v_ws IS NULL OR v_caller IS NULL OR v_me IS NULL) THEN
    RAISE EXCEPTION 'Only a person can invite people to a call' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.workspace_id, x.team_id, x.channel_id, x.state INTO m FROM app.meetings x WHERE x.id = p_meeting_id AND x.workspace_id = coalesce(v_ws, x.workspace_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such call' USING ERRCODE = 'no_data_found';
  END IF;
  IF m.channel_id IS NULL THEN
    RAISE EXCEPTION 'A call without a channel has nobody to invite' USING ERRCODE = 'check_violation';
  END IF;
  -- a call in a direct message rings everyone in it: the ring is the invitation
  IF (SELECT c.kind FROM app.channels c WHERE c.id = m.channel_id) = 'dm' THEN
    RAISE EXCEPTION 'A call in a direct message rings everyone; nobody is invited' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_system AND NOT coalesce(app.lookup_channel_can(m.channel_id, 'post'), false) THEN
    RAISE EXCEPTION 'Only someone who can post in the channel can invite people to its call' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This call has ended' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_ids FROM unnest(coalesce(p_person_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL;
  IF cardinality(v_ids) > 100 THEN
    RAISE EXCEPTION 'At most 100 people can be invited at once' USING ERRCODE = 'check_violation';
  END IF;
  -- the whole list, or nothing: a person who cannot read the channel is never asked, and the others are not asked without them either
  SELECT count(*) INTO v_outside FROM unnest(v_ids) x WHERE x NOT IN (SELECT au.person_id FROM app.channel_audience(m.channel_id) au);
  IF v_outside > 0 THEN
    RAISE EXCEPTION 'Everyone you invite must be able to read this channel' USING ERRCODE = 'insufficient_privilege';
  END IF;
  WITH added AS (
    INSERT INTO app.meeting_invites (meeting_id, person_id, display_name, invited_by, channel_id, team_id, workspace_id)
    SELECT m.id, p.id, left(coalesce(nullif(btrim(p.display_name), ''), 'Someone'), 200), coalesce(v_caller, (SELECT x.started_by FROM app.meetings x WHERE x.id = m.id)),
           m.channel_id, m.team_id, m.workspace_id
      FROM app.people p
     WHERE p.id = ANY (v_ids) AND p.id IS DISTINCT FROM v_me AND p.workspace_id = m.workspace_id
     ORDER BY p.id
    ON CONFLICT (meeting_id, person_id) DO NOTHING
    RETURNING person_id
  )
  SELECT coalesce(array_agg(person_id ORDER BY person_id), ARRAY[]::uuid[]) INTO v_new FROM added;
  RETURN v_new;
END
$$;

-- Row level security ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.meeting_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_invites_select ON app.meeting_invites FOR SELECT USING (
  (SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
);
CREATE POLICY meeting_invites_insert ON app.meeting_invites FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_invites_update ON app.meeting_invites FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_invites_delete ON app.meeting_invites FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.meeting_invites TO manythreads_app;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meetings_invite(uuid, uuid[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.meetings_invite(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_invite(uuid, uuid[]) TO manythreads_app, manythreads_system;
