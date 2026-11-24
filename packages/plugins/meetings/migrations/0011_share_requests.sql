-- meetings 0011: "Ask to share" (PLAN P17-02). Forward-only: never edit once applied.
--
-- One screen is shared in a call at a time (P35-08). While someone shares, another person in the call may ask them for a turn. A request lives for a minute and is
-- answered once: "Stop and let them share" (accepted) or "Not now" (declined); one left unanswered lapses by its `expires_at`. Nothing here decides who may share:
-- the media server lets anyone in the call publish a screen, and the page keeps it to one at a time. The table only makes sure that a request comes from someone in the
-- live call, goes to someone in the same call, and is answered only by the person it was sent to.
--
--   meeting_share_requests   UNLOGGED (a request is worth a minute; losing them in a crash costs a second press). One row per call and asker: asking again replaces
--                            the old row. Read by its asker and by the person asked; written only by the two functions below and the system role.

CREATE UNLOGGED TABLE app.meeting_share_requests (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id   uuid NOT NULL REFERENCES app.meetings (id) ON DELETE CASCADE,
  asker_id     uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  sharer_id    uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'declined')),
  asked_at     timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  answered_at  timestamptz,
  CHECK (asker_id <> sharer_id),
  CHECK ((state = 'pending') = (answered_at IS NULL)),
  UNIQUE (meeting_id, asker_id)
);
CREATE INDEX meeting_share_requests_asker ON app.meeting_share_requests (asker_id);
CREATE INDEX meeting_share_requests_sharer ON app.meeting_share_requests (sharer_id);
CREATE INDEX meeting_share_requests_workspace ON app.meeting_share_requests (workspace_id);
COMMENT ON TABLE app.meeting_share_requests IS 'rls: person — P: UNLOGGED requests for a turn to share a screen in a live call; read by the asker and the person asked, written only through app.meetings_ask_to_share / app.meetings_answer_share and the system role.';

-- Ask for a turn ---------------------------------------------------------------------------------------------------------------------------------------------
-- A definer owned by the system role: inside it `app.is_system()` is always true, so the caller is checked by `session_user` and by the actor of the request
-- (MISTAKES P2 review). The caller must be a person in the live call now, and so must the person asked (another person, not a bot). One request per asker and person
-- asked a minute: asking the same person again within a minute of the last request is refused, whatever its answer; a request to someone else replaces the old one
-- (the route's own limit, 10 a minute, caps going back and forth). Returns the new request.
--
-- The database cannot see who is sharing (the media server knows; the page keeps it to one at a time). A request to someone who is not sharing reaches only their page,
-- which ignores it; it is never answered, so it leaves no event and no audit row (the event is written when a request is answered, never when it is asked).
CREATE FUNCTION app.meetings_ask_to_share(p_meeting_id uuid, p_sharer_id uuid)
  RETURNS TABLE (request_id uuid, expires_at timestamptz, asker_name text, sharer_person_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  m        record;
  v_ws     uuid := app.workspace_id();
  v_caller uuid := app.actor();
  v_me     uuid := app.person_id();
  v_name   text;
  v_person uuid;
  v_row    app.meeting_share_requests;
BEGIN
  IF session_user = 'manythreads_system' OR v_ws IS NULL OR v_caller IS NULL OR v_me IS NULL THEN
    RAISE EXCEPTION 'Only a person in the call can ask to share' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.workspace_id, x.state INTO m FROM app.meetings x WHERE x.id = p_meeting_id AND x.workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such call' USING ERRCODE = 'no_data_found';
  END IF;
  -- someone who is not in the call learns nothing about it, not even that it has ended
  SELECT p.display_name INTO v_name FROM app.meeting_participants p WHERE p.meeting_id = m.id AND p.actor_id = v_caller AND p.left_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a person in the call can ask to share' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This call has ended' USING ERRCODE = 'check_violation';
  END IF;
  IF p_sharer_id IS NULL OR p_sharer_id = v_caller THEN
    RAISE EXCEPTION 'You cannot ask yourself' USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.person_id INTO v_person FROM app.meeting_participants p WHERE p.meeting_id = m.id AND p.actor_id = p_sharer_id AND p.left_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That person is not in the call now' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.meeting_share_requests r
              WHERE r.meeting_id = m.id AND r.asker_id = v_caller AND r.sharer_id = p_sharer_id AND r.asked_at > now() - interval '60 seconds') THEN
    RAISE EXCEPTION 'You already asked' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO app.meeting_share_requests AS r (meeting_id, asker_id, sharer_id, workspace_id, expires_at)
  VALUES (m.id, v_caller, p_sharer_id, m.workspace_id, now() + interval '60 seconds')
  ON CONFLICT (meeting_id, asker_id) DO UPDATE
     SET id = uuidv7(), sharer_id = EXCLUDED.sharer_id, state = 'pending', asked_at = now(), expires_at = EXCLUDED.expires_at, answered_at = NULL
  RETURNING r.* INTO v_row;
  RETURN QUERY SELECT v_row.id, v_row.expires_at, v_name, v_person;
END
$$;

-- Answer a request -------------------------------------------------------------------------------------------------------------------------------------------
-- Only the person asked answers, once, before the request lapses, while the call is live and they are still in it. A request of someone else is "no such request",
-- so nobody learns of requests that are not theirs. Saying yes also turns down every other request still waiting for the caller in this call (`other`): one asker is
-- let share, the others are told and may ask the next sharer. Returns one row per request answered, the one asked about first, with the asker for the push.
CREATE FUNCTION app.meetings_answer_share(p_request_id uuid, p_accept boolean)
  RETURNS TABLE (request_id uuid, asker_id uuid, asker_person_id uuid, outcome text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r        app.meeting_share_requests;
  v_ws     uuid := app.workspace_id();
  v_caller uuid := app.actor();
  v_person uuid;
BEGIN
  IF session_user = 'manythreads_system' OR v_ws IS NULL OR v_caller IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'Only the person asked can answer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM app.meeting_share_requests x WHERE x.id = p_request_id AND x.workspace_id = v_ws AND x.sharer_id = v_caller FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such request' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.state <> 'pending' THEN
    RAISE EXCEPTION 'You already answered' USING ERRCODE = 'check_violation';
  END IF;
  IF r.expires_at <= now() THEN
    RAISE EXCEPTION 'The request has timed out' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT x.state FROM app.meetings x WHERE x.id = r.meeting_id) <> 'live' THEN
    RAISE EXCEPTION 'This call has ended' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.meeting_participants p WHERE p.meeting_id = r.meeting_id AND p.actor_id = v_caller AND p.left_at IS NULL) THEN
    RAISE EXCEPTION 'You are not in the call now' USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.person_id INTO v_person FROM app.meeting_participants p WHERE p.meeting_id = r.meeting_id AND p.actor_id = r.asker_id;
  UPDATE app.meeting_share_requests x SET state = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, answered_at = now() WHERE x.id = r.id;
  RETURN QUERY SELECT r.id, r.asker_id, v_person, CASE WHEN p_accept THEN 'accept' ELSE 'decline' END;
  IF p_accept THEN
    RETURN QUERY
      WITH others AS (
        UPDATE app.meeting_share_requests x SET state = 'declined', answered_at = now()
         WHERE x.meeting_id = r.meeting_id AND x.sharer_id = v_caller AND x.id <> r.id AND x.state = 'pending' AND x.expires_at > now()
        RETURNING x.id, x.asker_id, x.asked_at
      )
      SELECT o.id, o.asker_id, p.person_id, 'other'::text
        FROM others o LEFT JOIN app.meeting_participants p ON p.meeting_id = r.meeting_id AND p.actor_id = o.asker_id
       ORDER BY o.asked_at, o.id;
  END IF;
END
$$;

-- Row level security ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.meeting_share_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_share_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_share_requests_select ON app.meeting_share_requests FOR SELECT USING (
  (SELECT app.is_system()) OR asker_id = (SELECT app.actor()) OR sharer_id = (SELECT app.actor())
);
CREATE POLICY meeting_share_requests_insert ON app.meeting_share_requests FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_share_requests_update ON app.meeting_share_requests FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_share_requests_delete ON app.meeting_share_requests FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.meeting_share_requests TO manythreads_app;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meetings_ask_to_share(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_answer_share(uuid, boolean) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.meetings_ask_to_share(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.meetings_answer_share(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_ask_to_share(uuid, uuid) TO manythreads_app;
GRANT EXECUTE ON FUNCTION app.meetings_answer_share(uuid, boolean) TO manythreads_app;
