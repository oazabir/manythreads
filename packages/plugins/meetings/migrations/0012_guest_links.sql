-- meetings 0012: guest links and the waiting room (PLAN P17-04, docs/plans/guest-links.md). Forward-only: never edit once applied.
--
-- A link guest is someone outside the workspace with no account (not a workspace guest, role `guest`): they get one call through a link a member made, wait until
-- someone in the call lets them in, and then hear and see the room and send their microphone and camera. They are not actors: participants, transcript lines and
-- presence stay people-only, and a guest never reaches a channel, a message or a file.
--
--   meeting_settings.guest_links_allowed  the workspace switch, on by default.
--   meetings.allow_guests                 guest links are on for this call: set by the starter's first link at the start, cleared by "Turn off guest links".
--   meeting_guest_links                   one row per link a member made. Only the sha-256 of its secret is kept (`token_hash`, never granted to the app role), so a
--                                         link cannot be shown again: each member gets a link of their own. A link works while the call is live, at most 12 hours,
--                                         at most `max_uses` knocks; at most 10 work at once per call. Ending the call turns every link off.
--   meeting_guests                        the record of who knocked and what happened (durable). The guest's credential is the sha-256 of a cookie secret
--                                         (`credential_hash`, never granted to the app role). No address is stored.
--   meeting_guest_presence                UNLOGGED heartbeat of a guest page: the sweep expires a waiting guest silent for a minute and drops an admitted one silent
--                                         for three.
--
-- Reads: whoever can read the call's channel reads its links (without the hash) and its guests (without the credential). Writes: only the definer functions
-- below (a member's: make a link, turn links off, let in, turn away, take out) and the system role (the guest's own public routes, the sweep, the end of a call).
-- Every definer is owned by the system role, so inside it `app.is_system()` is true: the caller is checked by `session_user`, `app.actor()` and the `lookup_*`
-- helpers, never by `is_*` (MISTAKES P2 review).

-- 1. the workspace switch and the call's switch ---------------------------------------------------------------------------------------------------------
ALTER TABLE app.meeting_settings ADD COLUMN guest_links_allowed boolean NOT NULL DEFAULT true;
GRANT INSERT (guest_links_allowed) ON app.meeting_settings TO manythreads_app;
GRANT UPDATE (guest_links_allowed) ON app.meeting_settings TO manythreads_app;

ALTER TABLE app.meetings ADD COLUMN allow_guests boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN app.meetings.allow_guests IS 'guest links are on for this call (P17-04); only app.meetings_make_guest_link turns it on and app.meetings_revoke_guest_links off.';

-- A caller's insert never starts a call with guest links on: the first link (a definer, in the same transaction as the start) turns them on. Not a definer on
-- purpose, so `session_user` is the caller's login. The meetings_guard trigger (0001, 0007) already keeps a caller from changing the column later.
CREATE FUNCTION app.meetings_guests_before_insert() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF session_user <> 'manythreads_system' THEN
    NEW.allow_guests := false;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER meetings_guests_before_insert BEFORE INSERT ON app.meetings FOR EACH ROW EXECUTE FUNCTION app.meetings_guests_before_insert();

-- 2. the tables ---------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.meeting_guest_links (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id   uuid NOT NULL REFERENCES app.meetings (id) ON DELETE CASCADE,
  -- copied from the meeting, so the policy probes the visibility set without reading the meeting
  channel_id   uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  team_id      uuid REFERENCES app.teams (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- sha-256 of the 32 random bytes in the address; looked up by equality, never selected by the app role
  token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_by   uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  max_uses     integer NOT NULL DEFAULT 50 CHECK (max_uses BETWEEN 1 AND 100),
  uses         integer NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '12 hours')
);
CREATE INDEX meeting_guest_links_meeting ON app.meeting_guest_links (meeting_id);
CREATE INDEX meeting_guest_links_live ON app.meeting_guest_links (meeting_id) WHERE revoked_at IS NULL;
CREATE INDEX meeting_guest_links_channel ON app.meeting_guest_links (channel_id);
CREATE INDEX meeting_guest_links_team ON app.meeting_guest_links (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX meeting_guest_links_workspace ON app.meeting_guest_links (workspace_id);
CREATE INDEX meeting_guest_links_created_by ON app.meeting_guest_links (created_by);
CREATE INDEX meeting_guest_links_revoked_by ON app.meeting_guest_links (revoked_by) WHERE revoked_by IS NOT NULL;
COMMENT ON TABLE app.meeting_guest_links IS 'rls: team — C: guest links of a call, readable (without token_hash) by whoever can read the call''s channel; written only through app.meetings_make_guest_link, app.meetings_revoke_guest_links, app.meetings_guest_knock and the system role.';

CREATE TABLE app.meeting_guests (
  -- the guest's media identity is `guest:<id>`
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  link_id         uuid NOT NULL REFERENCES app.meeting_guest_links (id) ON DELETE CASCADE,
  meeting_id      uuid NOT NULL REFERENCES app.meetings (id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  team_id         uuid REFERENCES app.teams (id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  display_name    text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60 AND display_name !~ '[\x01-\x1f\x7f-\x9f  ‪-‮⁦-⁩]'),
  -- sha-256 of the cookie secret; looked up by equality, never selected by the app role
  credential_hash bytea NOT NULL UNIQUE CHECK (octet_length(credential_hash) = 32),
  state           text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'admitted', 'denied', 'removed', 'left', 'expired')),
  asked_at        timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  decided_by      uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  joined_at       timestamptz,
  left_at         timestamptz
);
CREATE INDEX meeting_guests_link ON app.meeting_guests (link_id);
CREATE INDEX meeting_guests_meeting ON app.meeting_guests (meeting_id, asked_at);
CREATE INDEX meeting_guests_active ON app.meeting_guests (meeting_id) WHERE state IN ('waiting', 'admitted');
CREATE INDEX meeting_guests_channel ON app.meeting_guests (channel_id);
CREATE INDEX meeting_guests_team ON app.meeting_guests (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX meeting_guests_workspace ON app.meeting_guests (workspace_id);
CREATE INDEX meeting_guests_decided_by ON app.meeting_guests (decided_by) WHERE decided_by IS NOT NULL;
COMMENT ON TABLE app.meeting_guests IS 'rls: team — C: link guests of a call (who knocked, who let them in), readable (without credential_hash) by whoever can read the call''s channel; written only through app.meetings_guest_knock, app.meetings_decide_guest and the system role.';

CREATE UNLOGGED TABLE app.meeting_guest_presence (
  guest_id   uuid PRIMARY KEY REFERENCES app.meeting_guests (id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES app.meetings (id) ON DELETE CASCADE,
  seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_guest_presence_meeting ON app.meeting_guest_presence (meeting_id);
CREATE INDEX meeting_guest_presence_seen ON app.meeting_guest_presence (seen_at);
COMMENT ON TABLE app.meeting_guest_presence IS 'rls: system — S: UNLOGGED heartbeat of a link guest''s page; written and read only by the system role (the guest routes and the sweep).';

-- 3. a member makes a link -----------------------------------------------------------------------------------------------------------------------------
-- The caller is a person of the workspace who is not a workspace guest, may post in the call's channel (not a direct message), and the call is live. Guest links
-- must be on for the call, except for the starter's first link at the start (`p_turn_on`): that one turns them on. The workspace switch must be on, and at most
-- 10 links of the call may work at once. The route draws the secret and passes only its hash.
CREATE FUNCTION app.meetings_make_guest_link(p_meeting_id uuid, p_token_hash bytea, p_turn_on boolean)
  RETURNS TABLE (link_id uuid, expires_at timestamptz, team_id uuid, channel_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  m        record;
  v_ws     uuid := app.workspace_id();
  v_caller uuid := app.actor();
  v_role   text := app.lookup_workspace_role();
  v_kind   text;
  v_live   integer;
  v_row    app.meeting_guest_links;
BEGIN
  IF session_user = 'manythreads_system' OR v_ws IS NULL OR v_caller IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'Only a person can make a guest link' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'a link is kept as a sha-256' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.id, x.workspace_id, x.team_id, x.channel_id, x.state, x.started_by, x.allow_guests INTO m
    FROM app.meetings x WHERE x.id = p_meeting_id AND x.workspace_id = v_ws FOR UPDATE;
  IF NOT FOUND OR m.channel_id IS NULL OR NOT (m.channel_id = ANY (app.visible_channel_ids('read'))) THEN
    RAISE EXCEPTION 'no such call' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'A workspace guest cannot make a guest link' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This call has ended' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.kind INTO v_kind FROM app.channels c WHERE c.id = m.channel_id;
  IF v_kind = 'dm' THEN
    RAISE EXCEPTION 'A call in a direct message has no guest links' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(app.lookup_channel_can(m.channel_id, 'post'), false) THEN
    RAISE EXCEPTION 'You cannot make a guest link in this channel' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce((SELECT s.guest_links_allowed FROM app.meeting_settings s WHERE s.workspace_id = v_ws), true) THEN
    RAISE EXCEPTION 'Guest links are switched off for this workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT m.allow_guests THEN
    IF NOT coalesce(p_turn_on, false) OR m.started_by <> v_caller OR EXISTS (SELECT 1 FROM app.meeting_guest_links l WHERE l.meeting_id = m.id) THEN
      RAISE EXCEPTION 'Guest links are off for this call' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE app.meetings x SET allow_guests = true WHERE x.id = m.id;
  END IF;
  SELECT count(*)::int INTO v_live FROM app.meeting_guest_links l
   WHERE l.meeting_id = m.id AND l.revoked_at IS NULL AND l.expires_at > now() AND l.uses < l.max_uses;
  IF v_live >= 10 THEN
    RAISE EXCEPTION 'At most 10 guest links of a call work at once' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.meeting_guest_links AS l (meeting_id, channel_id, team_id, workspace_id, token_hash, created_by, expires_at)
  VALUES (m.id, m.channel_id, m.team_id, m.workspace_id, p_token_hash, v_caller, now() + interval '12 hours')
  RETURNING l.* INTO v_row;
  RETURN QUERY SELECT v_row.id, v_row.expires_at, v_row.team_id, v_row.channel_id;
END
$$;

-- 4. turn guest links off ----------------------------------------------------------------------------------------------------------------------------------
-- The starter, a lead of the channel's team or a workspace admin (the people who may end the call), for a live call they can read. Every link of the call stops
-- working and the call's switch goes off; guests already in stay (Remove takes one out). Returns the links that were still working.
CREATE FUNCTION app.meetings_revoke_guest_links(p_meeting_id uuid)
  RETURNS TABLE (link_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  m        record;
  v_ws     uuid := app.workspace_id();
  v_caller uuid := app.actor();
BEGIN
  IF session_user = 'manythreads_system' OR v_ws IS NULL OR v_caller IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'Only a person can turn guest links off' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.channel_id, x.state, x.started_by INTO m FROM app.meetings x WHERE x.id = p_meeting_id AND x.workspace_id = v_ws FOR UPDATE;
  IF NOT FOUND OR m.channel_id IS NULL OR NOT (m.channel_id = ANY (app.visible_channel_ids('read'))) THEN
    RAISE EXCEPTION 'no such call' USING ERRCODE = 'no_data_found';
  END IF;
  IF m.started_by <> v_caller AND NOT coalesce(app.lookup_channel_can(m.channel_id, 'manage'), false) THEN
    RAISE EXCEPTION 'Only the person who started the call, a team lead or an admin can turn guest links off' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This call has ended' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.meetings x SET allow_guests = false WHERE x.id = m.id AND x.allow_guests;
  RETURN QUERY
    WITH stopped AS (
      UPDATE app.meeting_guest_links l SET revoked_at = now(), revoked_by = v_caller
       WHERE l.meeting_id = m.id AND l.revoked_at IS NULL AND l.expires_at > now() AND l.uses < l.max_uses
      RETURNING l.id
    )
    SELECT s.id FROM stopped s;
  -- the links that had already stopped (expired, used up) are marked too, so nothing of the call is left unrevoked
  UPDATE app.meeting_guest_links l SET revoked_at = now(), revoked_by = v_caller WHERE l.meeting_id = m.id AND l.revoked_at IS NULL;
END
$$;

-- 5. a guest knocks (the system role only: the guest's routes are public and run as the system) ------------------------------------------------------------
-- Looks the link up by its hash and locks it; an unknown, revoked, expired or used-up link, a call that has ended or turned links off, and a workspace that
-- switched them off all answer the same `no_data_found`. At most 10 guests of a call wait at once. A use is counted and the guest's row is made, waiting.
CREATE FUNCTION app.meetings_guest_knock(p_link_hash bytea, p_display_name text, p_credential_hash bytea)
  RETURNS TABLE (guest_id uuid, link_id uuid, meeting_id uuid, workspace_id uuid, team_id uuid, channel_id uuid, expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  l       app.meeting_guest_links;
  m       record;
  v_wait  integer;
  v_guest uuid;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the guest routes knock' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.* INTO l FROM app.meeting_guest_links x WHERE x.token_hash = p_link_hash FOR UPDATE;
  IF NOT FOUND OR l.revoked_at IS NOT NULL OR l.expires_at <= now() OR l.uses >= l.max_uses THEN
    RAISE EXCEPTION 'no such link' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT x.id, x.state, x.allow_guests INTO m FROM app.meetings x WHERE x.id = l.meeting_id FOR SHARE;
  IF NOT FOUND OR m.state <> 'live' OR NOT m.allow_guests
     OR NOT coalesce((SELECT s.guest_links_allowed FROM app.meeting_settings s WHERE s.workspace_id = l.workspace_id), true) THEN
    RAISE EXCEPTION 'no such link' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT count(*)::int INTO v_wait FROM app.meeting_guests g WHERE g.meeting_id = l.meeting_id AND g.state = 'waiting';
  IF v_wait >= 10 THEN
    RAISE EXCEPTION 'The waiting room of this call is full' USING ERRCODE = 'program_limit_exceeded';
  END IF;
  UPDATE app.meeting_guest_links x SET uses = x.uses + 1 WHERE x.id = l.id;
  INSERT INTO app.meeting_guests AS g (link_id, meeting_id, channel_id, team_id, workspace_id, display_name, credential_hash)
  VALUES (l.id, l.meeting_id, l.channel_id, l.team_id, l.workspace_id, p_display_name, p_credential_hash)
  RETURNING g.id INTO v_guest;
  RETURN QUERY SELECT v_guest, l.id, l.meeting_id, l.workspace_id, l.team_id, l.channel_id, l.expires_at;
END
$$;

-- 6. let in, turn away, take out ---------------------------------------------------------------------------------------------------------------------------
-- Any person in the live call now who is not a workspace guest. Whoever answers first wins: the row is locked and a second answer finds it decided. Letting in
-- counts the room the way a join does (people present plus guests let in, against the workspace's room size), under the same lock as a join. Taking out works
-- for a guest let in or still waiting; the guest's credential is dead from then on (every guest route reads the state).
CREATE FUNCTION app.meetings_decide_guest(p_meeting_id uuid, p_guest_id uuid, p_decision text)
  RETURNS TABLE (state text, workspace_id uuid, team_id uuid, channel_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  m        record;
  g        app.meeting_guests;
  v_ws     uuid := app.workspace_id();
  v_caller uuid := app.actor();
  v_role   text := app.lookup_workspace_role();
  v_people integer;
  v_cap    integer;
  v_next   text;
BEGIN
  IF p_decision NOT IN ('admit', 'deny', 'remove') THEN
    RAISE EXCEPTION 'unknown decision' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF session_user = 'manythreads_system' OR v_ws IS NULL OR v_caller IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'Only someone in the call can let a guest in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.workspace_id, x.team_id, x.channel_id, x.state INTO m FROM app.meetings x WHERE x.id = p_meeting_id AND x.workspace_id = v_ws;
  IF NOT FOUND OR m.channel_id IS NULL OR NOT (m.channel_id = ANY (app.visible_channel_ids('read'))) THEN
    RAISE EXCEPTION 'no such call' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_role IS NULL OR v_role = 'guest'
     OR NOT EXISTS (SELECT 1 FROM app.meeting_participants p WHERE p.meeting_id = m.id AND p.actor_id = v_caller AND p.left_at IS NULL) THEN
    RAISE EXCEPTION 'Only someone in the call can let a guest in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This call has ended' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'admit' THEN
    -- the same lock as a join (limits.ts assertRoomHasSpace): joins and admissions to one room go one after the other
    PERFORM pg_advisory_xact_lock(hashtext('meetings.join:' || m.id::text));
  END IF;
  SELECT x.* INTO g FROM app.meeting_guests x WHERE x.id = p_guest_id AND x.meeting_id = m.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such guest' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_decision IN ('admit', 'deny') AND (g.state <> 'waiting' OR g.asked_at <= now() - interval '600 seconds') THEN
    RAISE EXCEPTION 'Someone already answered' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'remove' AND g.state NOT IN ('waiting', 'admitted') THEN
    RAISE EXCEPTION 'That guest is not in the call' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'admit' THEN
    SELECT count(*)::int INTO v_people FROM app.meeting_participants p WHERE p.meeting_id = m.id AND p.left_at IS NULL;
    v_people := v_people + (SELECT count(*)::int FROM app.meeting_guests x WHERE x.meeting_id = m.id AND x.state = 'admitted');
    v_cap := coalesce((SELECT s.room_cap FROM app.meeting_settings s WHERE s.workspace_id = m.workspace_id), 25);
    IF v_people >= v_cap THEN
      RAISE EXCEPTION 'The call is full' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_next := CASE p_decision WHEN 'admit' THEN 'admitted' WHEN 'deny' THEN 'denied' ELSE 'removed' END;
  UPDATE app.meeting_guests x
     SET state = v_next, decided_at = now(), decided_by = v_caller,
         joined_at = CASE WHEN v_next = 'admitted' THEN now() ELSE x.joined_at END,
         left_at = CASE WHEN v_next = 'removed' THEN now() ELSE x.left_at END
   WHERE x.id = g.id;
  IF v_next <> 'admitted' THEN
    DELETE FROM app.meeting_guest_presence r WHERE r.guest_id = g.id;
  END IF;
  RETURN QUERY SELECT v_next, m.workspace_id, m.team_id, m.channel_id;
END
$$;

-- 7. the end of a call: its guests are gone and its links stop -------------------------------------------------------------------------------------------
-- Whoever ends the call (a person through app.meetings_end, or the system's empty-room job), in the same statement. The plugin writes the events (it reads the
-- guests and links before the end).
CREATE FUNCTION app.meetings_guests_on_end() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.meeting_guests g SET state = CASE WHEN g.state = 'waiting' THEN 'expired' ELSE 'left' END, left_at = now()
   WHERE g.meeting_id = NEW.id AND g.state IN ('waiting', 'admitted');
  UPDATE app.meeting_guest_links l SET revoked_at = now() WHERE l.meeting_id = NEW.id AND l.revoked_at IS NULL;
  DELETE FROM app.meeting_guest_presence r WHERE r.meeting_id = NEW.id;
  RETURN NULL;
END
$$;
CREATE TRIGGER meetings_guests_on_end AFTER UPDATE OF state ON app.meetings FOR EACH ROW
  WHEN (OLD.state = 'live' AND NEW.state = 'ended') EXECUTE FUNCTION app.meetings_guests_on_end();

-- 8. row level security ------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.meeting_guest_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_guest_links FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_guest_links_select ON app.meeting_guest_links FOR SELECT USING (
  (SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
);
CREATE POLICY meeting_guest_links_insert ON app.meeting_guest_links FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_guest_links_update ON app.meeting_guest_links FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_guest_links_delete ON app.meeting_guest_links FOR DELETE USING ((SELECT app.is_system()));
-- every column but the hash
GRANT SELECT (id, meeting_id, channel_id, team_id, workspace_id, created_by, created_at, expires_at, max_uses, uses, revoked_at, revoked_by)
  ON app.meeting_guest_links TO manythreads_app;

ALTER TABLE app.meeting_guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_guests FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_guests_select ON app.meeting_guests FOR SELECT USING (
  (SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
);
CREATE POLICY meeting_guests_insert ON app.meeting_guests FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_guests_update ON app.meeting_guests FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_guests_delete ON app.meeting_guests FOR DELETE USING ((SELECT app.is_system()));
-- every column but the credential
GRANT SELECT (id, link_id, meeting_id, channel_id, team_id, workspace_id, display_name, state, asked_at, decided_at, decided_by, joined_at, left_at)
  ON app.meeting_guests TO manythreads_app;

ALTER TABLE app.meeting_guest_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_guest_presence FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_guest_presence_all ON app.meeting_guest_presence FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- 9. owners and rights of the functions ----------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meetings_make_guest_link(uuid, bytea, boolean) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_revoke_guest_links(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_guest_knock(bytea, text, bytea) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_decide_guest(uuid, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_guests_on_end() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.meetings_make_guest_link(uuid, bytea, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.meetings_revoke_guest_links(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.meetings_guest_knock(bytea, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.meetings_decide_guest(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_make_guest_link(uuid, bytea, boolean) TO manythreads_app;
GRANT EXECUTE ON FUNCTION app.meetings_revoke_guest_links(uuid) TO manythreads_app;
GRANT EXECUTE ON FUNCTION app.meetings_decide_guest(uuid, uuid, text) TO manythreads_app;
-- the knock is the guest's, and the guest's routes run as the system role only
GRANT EXECUTE ON FUNCTION app.meetings_guest_knock(bytea, text, bytea) TO manythreads_system;
