-- meetings 0001: voice rooms (PLAN P15-01, P15-03). Forward-only: never edit once applied.
--
-- A meeting is one voice room opened from a channel (a call in a direct message uses the DM's channel, so `team_id` is null there). Whoever can read the channel
-- reads the room and may join it; whoever may post there may start one. Three durable tables and one UNLOGGED one:
--
--   meetings              the room: who started it, its state (`live` or `ended`), the settings later tasks turn on (transcription, recording), where the transcript went.
--   meeting_participants  who is in the room or was: one row per person and room. The name is copied here because `actors` shows a caller only themself.
--   meeting_segments      the transcript lines (P15-05 on). Written by the speaker's own device or the server fallback; never edited.
--   meeting_presence      UNLOGGED. "I am still here" every 30 seconds; a person silent for three minutes is counted as gone (the sweep job in the plugin).
--
-- ONE LIVE ROOM PER CHANNEL is a unique index, so two people pressing Start at once end up in the same room. A room ends for good: a new call in the same channel
-- is a new meeting. The people who may end it are the starter, a lead of the channel's team and a workspace admin (app.meetings_end below); the plugin's job ends
-- a room that has been empty for two minutes through the same function (as the system role).
--
-- A room belongs to its channel: when the channel is removed, so is the room (a deleted private channel must not leave its calls readable by the whole team).

CREATE TABLE app.meetings (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id       uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id            uuid REFERENCES app.teams (id) ON DELETE CASCADE,
  channel_id         uuid REFERENCES app.channels (id) ON DELETE CASCADE,
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title !~ '[\x01-\x1f\x7f-\x9f  ]'),
  state              text NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'ended')),
  started_by         uuid NOT NULL REFERENCES app.actors (id),
  organizer_id       uuid NOT NULL REFERENCES app.actors (id),
  notetaker_bot_id   uuid REFERENCES app.bots (id) ON DELETE SET NULL,
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz,
  ended_by           uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  end_reason         text CHECK (end_reason IN ('person', 'empty')),
  transcription      text NOT NULL DEFAULT 'off' CHECK (transcription IN ('on_device', 'server', 'off')),
  recording          boolean NOT NULL DEFAULT false,
  transcript_path    text CHECK (transcript_path IS NULL OR char_length(transcript_path) <= 500),
  transcript_file_id uuid REFERENCES app.files (id) ON DELETE SET NULL,
  -- the root message of the call's chat thread in the channel; null when it could not be made
  thread_root_id     uuid REFERENCES app.messages (id) ON DELETE SET NULL,
  -- when the last person left; null while somebody is in. The auto-end job and the sweep read it.
  empty_since        timestamptz,
  CONSTRAINT meetings_state_shape CHECK (
    (state = 'live' AND ended_at IS NULL AND end_reason IS NULL AND ended_by IS NULL)
    OR (state = 'ended' AND ended_at IS NOT NULL AND end_reason IS NOT NULL)),
  CONSTRAINT meetings_place CHECK (channel_id IS NOT NULL OR team_id IS NOT NULL)
);
CREATE UNIQUE INDEX meetings_one_live_per_channel ON app.meetings (channel_id) WHERE state = 'live' AND channel_id IS NOT NULL;
CREATE INDEX meetings_channel ON app.meetings (channel_id, started_at DESC) WHERE channel_id IS NOT NULL;
CREATE INDEX meetings_team_live ON app.meetings (team_id, started_at DESC) WHERE team_id IS NOT NULL;
CREATE INDEX meetings_workspace_live ON app.meetings (workspace_id) WHERE state = 'live';
CREATE INDEX meetings_started_by ON app.meetings (started_by);
CREATE INDEX meetings_organizer ON app.meetings (organizer_id);
CREATE INDEX meetings_ended_by ON app.meetings (ended_by) WHERE ended_by IS NOT NULL;
CREATE INDEX meetings_notetaker ON app.meetings (notetaker_bot_id) WHERE notetaker_bot_id IS NOT NULL;
CREATE INDEX meetings_transcript_file ON app.meetings (transcript_file_id) WHERE transcript_file_id IS NOT NULL;
CREATE INDEX meetings_thread_root ON app.meetings (thread_root_id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX meetings_empty ON app.meetings (empty_since) WHERE state = 'live' AND empty_since IS NOT NULL;
COMMENT ON TABLE app.meetings IS 'rls: team — C: voice rooms of the channels the caller can read (app.visible_channel_ids), or of a team the caller can read when the room has no channel; started by whoever can post in the channel, ended through app.meetings_end.';

CREATE TABLE app.meeting_participants (
  meeting_id         uuid NOT NULL REFERENCES app.meetings (id) ON DELETE CASCADE,
  actor_id           uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  -- copied from the actor, so a reader who cannot read `actors` still sees who is there
  person_id          uuid NOT NULL,
  display_name       text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  -- copied from the meeting, so the policy can probe the visibility set without reading the meeting
  channel_id         uuid,
  team_id            uuid,
  workspace_id       uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  first_joined_at    timestamptz NOT NULL DEFAULT now(),
  -- the latest time the person came in; left_at is null while they are in
  joined_at          timestamptz NOT NULL DEFAULT now(),
  left_at            timestamptz,
  consent_transcribe text NOT NULL DEFAULT 'unasked' CHECK (consent_transcribe IN ('yes', 'no', 'unasked')),
  consent_record     text NOT NULL DEFAULT 'unasked' CHECK (consent_record IN ('yes', 'no', 'unasked')),
  PRIMARY KEY (meeting_id, actor_id)
);
CREATE INDEX meeting_participants_actor ON app.meeting_participants (actor_id);
CREATE INDEX meeting_participants_channel ON app.meeting_participants (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX meeting_participants_workspace ON app.meeting_participants (workspace_id);
CREATE INDEX meeting_participants_present ON app.meeting_participants (meeting_id) WHERE left_at IS NULL;
COMMENT ON TABLE app.meeting_participants IS 'rls: team — C: who is or was in a voice room, readable by whoever can read the room; a person writes only their own row, and only a person (never a bot).';

CREATE TABLE app.meeting_segments (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id uuid NOT NULL REFERENCES app.meetings (id) ON DELETE CASCADE,
  speaker_id uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  channel_id uuid,
  team_id    uuid,
  start_ms   integer NOT NULL CHECK (start_ms >= 0),
  end_ms     integer NOT NULL CHECK (end_ms >= start_ms),
  text       text NOT NULL CHECK (char_length(text) <= 4000),
  final      boolean NOT NULL DEFAULT true,
  source     text NOT NULL CHECK (source IN ('device', 'server')),
  lang       text CHECK (lang IS NULL OR char_length(lang) <= 16),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_segments_meeting ON app.meeting_segments (meeting_id, start_ms, id);
CREATE INDEX meeting_segments_speaker ON app.meeting_segments (speaker_id);
COMMENT ON TABLE app.meeting_segments IS 'rls: team — C: transcript lines of a voice room, readable by whoever can read the room; written by the speaker themself while the room is live, never changed.';

CREATE UNLOGGED TABLE app.meeting_presence (
  meeting_id uuid NOT NULL REFERENCES app.meetings (id) ON DELETE CASCADE,
  actor_id   uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  speaking   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (meeting_id, actor_id)
);
CREATE INDEX meeting_presence_actor ON app.meeting_presence (actor_id);
CREATE INDEX meeting_presence_seen ON app.meeting_presence (seen_at);
COMMENT ON TABLE app.meeting_presence IS 'rls: person — P: UNLOGGED heartbeat of a person in a voice room; a person writes only their own row, the system role (the sweep) reads and clears every row.';

-- meetings: what a new room must be, whoever inserts it. Place and workspace come from the channel; the starter is the organizer; a room starts live.
CREATE FUNCTION app.meetings_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  c app.channels;
BEGIN
  IF NEW.channel_id IS NOT NULL THEN
    SELECT * INTO c FROM app.channels WHERE id = NEW.channel_id;
    IF NOT FOUND OR c.workspace_id <> NEW.workspace_id THEN
      RAISE EXCEPTION 'a voice room belongs to a channel of the same workspace' USING ERRCODE = 'check_violation';
    END IF;
    NEW.team_id := c.team_id;
  END IF;
  IF session_user <> 'manythreads_system' THEN
    NEW.state := 'live';
    NEW.ended_at := NULL;
    NEW.ended_by := NULL;
    NEW.end_reason := NULL;
    NEW.organizer_id := NEW.started_by;
    NEW.notetaker_bot_id := NULL;
    NEW.transcription := 'off';
    NEW.recording := false;
    NEW.transcript_path := NULL;
    NEW.transcript_file_id := NULL;
    NEW.empty_since := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER meetings_before_insert BEFORE INSERT ON app.meetings FOR EACH ROW EXECUTE FUNCTION app.meetings_before_insert();

-- meetings: what a caller may change directly: the call thread's root message (right after the start, by the starter) and nothing else. Ending is
-- app.meetings_end; the plugin's jobs and the media server's notices run as the system role and change what they need (empty_since, the settings).
CREATE FUNCTION app.meetings_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    IF (to_jsonb(NEW) - 'thread_root_id') IS DISTINCT FROM (to_jsonb(OLD) - 'thread_root_id') THEN
      RAISE EXCEPTION 'a voice room changes only through its own functions' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.state = 'ended' AND (NEW.state <> 'ended' OR NEW.ended_at IS DISTINCT FROM OLD.ended_at) THEN
    RAISE EXCEPTION 'this voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER meetings_guard BEFORE UPDATE ON app.meetings FOR EACH ROW EXECUTE FUNCTION app.meetings_guard();

-- meeting_participants: place and workspace come from the meeting, the name and person from the actor. Only a live room takes a new person; only a person
-- (never a bot) is a participant. The rest of the row is the caller's to change: joining again clears left_at, leaving sets it.
CREATE FUNCTION app.meeting_participants_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
  a app.actors;
  p app.people;
BEGIN
  SELECT * INTO m FROM app.meetings WHERE id = NEW.meeting_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO a FROM app.actors WHERE id = NEW.actor_id;
  IF NOT FOUND OR a.kind <> 'person' OR a.workspace_id <> m.workspace_id THEN
    RAISE EXCEPTION 'only people of the workspace join a voice room' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO p FROM app.people WHERE id = a.ref_id;
  NEW.person_id := a.ref_id;
  NEW.display_name := coalesce(nullif(btrim(p.display_name), ''), 'Someone');
  NEW.workspace_id := m.workspace_id;
  NEW.channel_id := m.channel_id;
  NEW.team_id := m.team_id;
  NEW.first_joined_at := now();
  NEW.joined_at := now();
  NEW.left_at := NULL;
  NEW.consent_transcribe := 'unasked';
  NEW.consent_record := 'unasked';
  RETURN NEW;
END
$$;
CREATE TRIGGER meeting_participants_before_insert BEFORE INSERT ON app.meeting_participants FOR EACH ROW EXECUTE FUNCTION app.meeting_participants_before_insert();

-- meeting_participants: who the row is about never changes; coming in again needs a live room; the consent answers are the person's own.
CREATE FUNCTION app.meeting_participants_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
BEGIN
  IF NEW.meeting_id <> OLD.meeting_id OR NEW.actor_id <> OLD.actor_id OR NEW.person_id <> OLD.person_id OR NEW.first_joined_at <> OLD.first_joined_at
     OR NEW.workspace_id <> OLD.workspace_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    RAISE EXCEPTION 'a participant keeps their room' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.left_at IS NOT NULL AND NEW.left_at IS NULL THEN
    SELECT * INTO m FROM app.meetings WHERE id = NEW.meeting_id FOR SHARE;
    IF NOT FOUND OR m.state <> 'live' THEN
      RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
    END IF;
    NEW.joined_at := now();
  ELSE
    NEW.joined_at := OLD.joined_at;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER meeting_participants_guard BEFORE UPDATE ON app.meeting_participants FOR EACH ROW EXECUTE FUNCTION app.meeting_participants_guard();

-- meetings.empty_since follows the people: set when the last one has left, cleared when somebody is in. Kept here, in the same statement as the join or the
-- leave, so the two-minute auto-end (the plugin's job) never reads a stale value, whoever makes the change (the person, a kick, the sweep).
CREATE FUNCTION app.meeting_participants_track() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.meeting_participants WHERE meeting_id = NEW.meeting_id AND left_at IS NULL) THEN
    UPDATE app.meetings SET empty_since = NULL WHERE id = NEW.meeting_id AND state = 'live' AND empty_since IS NOT NULL;
  ELSE
    UPDATE app.meetings SET empty_since = now() WHERE id = NEW.meeting_id AND state = 'live' AND empty_since IS NULL;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER meeting_participants_track AFTER INSERT OR UPDATE OF left_at ON app.meeting_participants FOR EACH ROW EXECUTE FUNCTION app.meeting_participants_track();

-- meeting_segments: place from the meeting; only a live room takes a line; a line is final text with a speaker who is (or was) in the room.
CREATE FUNCTION app.meeting_segments_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
BEGIN
  SELECT * INTO m FROM app.meetings WHERE id = NEW.meeting_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF m.state <> 'live' AND session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  NEW.channel_id := m.channel_id;
  NEW.team_id := m.team_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER meeting_segments_before_insert BEFORE INSERT ON app.meeting_segments FOR EACH ROW EXECUTE FUNCTION app.meeting_segments_before_insert();

-- Ending a room: its starter, a lead of the channel's team or a workspace admin (the same people who manage the channel), for a caller who can read it. The
-- system role (the empty-room job) ends with no check. Everyone still in the room is marked as having left. Returns false when it had ended already.
CREATE FUNCTION app.meetings_end(p_meeting_id uuid, p_reason text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
  v_system boolean := session_user = 'manythreads_system';
BEGIN
  IF p_reason NOT IN ('person', 'empty') THEN
    RAISE EXCEPTION 'unknown reason' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO m FROM app.meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND OR (NOT v_system AND m.workspace_id <> app.workspace_id()) THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT v_system THEN
    IF app.actor() IS NULL OR app.person_id() IS NULL
       OR NOT (
         (m.channel_id IS NOT NULL AND m.channel_id = ANY (app.visible_channel_ids('read')))
         OR (m.channel_id IS NULL AND m.team_id = ANY (app.readable_team_ids('read')))) THEN
      RAISE EXCEPTION 'you cannot end this voice room' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF m.started_by <> app.actor()
       AND NOT coalesce(CASE WHEN m.channel_id IS NOT NULL THEN app.lookup_channel_can(m.channel_id, 'manage') ELSE app.lookup_can_team(m.team_id, 'manage') END, false) THEN
      RAISE EXCEPTION 'only the person who started the room, a team lead or an admin can end it' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF m.state = 'ended' THEN
    RETURN false;
  END IF;
  UPDATE app.meetings
     SET state = 'ended', ended_at = now(), end_reason = p_reason, empty_since = NULL,
         ended_by = CASE WHEN v_system THEN NULL ELSE app.actor() END
   WHERE id = p_meeting_id;
  UPDATE app.meeting_participants SET left_at = now() WHERE meeting_id = p_meeting_id AND left_at IS NULL;
  DELETE FROM app.meeting_presence WHERE meeting_id = p_meeting_id;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.meetings_end(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_end(uuid, text) TO manythreads_app, manythreads_system;

-- Row level security ---------------------------------------------------------------------------------------------------------------
ALTER TABLE app.meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meetings FORCE ROW LEVEL SECURITY;
CREATE POLICY meetings_select ON app.meetings FOR SELECT USING (
  (SELECT app.is_system())
  OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
  OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])));
-- A person (never a bot) who may post in the channel starts a room.
CREATE POLICY meetings_insert ON app.meetings FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (started_by = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL AND workspace_id = (SELECT app.workspace_id())
      AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])));
-- The starter sets the call thread's root message; the guard allows nothing else. The system role is the jobs' and the media notices'.
CREATE POLICY meetings_update ON app.meetings FOR UPDATE
  USING ((SELECT app.is_system()) OR started_by = (SELECT app.actor()))
  WITH CHECK ((SELECT app.is_system()) OR (started_by = (SELECT app.actor()) AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY meetings_delete ON app.meetings FOR DELETE USING ((SELECT app.is_system()));

ALTER TABLE app.meeting_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_participants_select ON app.meeting_participants FOR SELECT USING (
  (SELECT app.is_system())
  OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
  OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])));
CREATE POLICY meeting_participants_insert ON app.meeting_participants FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (actor_id = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL
      AND EXISTS (SELECT 1 FROM app.meetings m WHERE m.id = meeting_id)));
CREATE POLICY meeting_participants_update ON app.meeting_participants FOR UPDATE
  USING ((SELECT app.is_system()) OR actor_id = (SELECT app.actor()))
  WITH CHECK ((SELECT app.is_system()) OR (actor_id = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL));
CREATE POLICY meeting_participants_delete ON app.meeting_participants FOR DELETE USING ((SELECT app.is_system()));

ALTER TABLE app.meeting_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_segments FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_segments_select ON app.meeting_segments FOR SELECT USING (
  (SELECT app.is_system())
  OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
  OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])));
CREATE POLICY meeting_segments_insert ON app.meeting_segments FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (speaker_id = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL AND source = 'device'
      AND EXISTS (SELECT 1 FROM app.meeting_participants p WHERE p.meeting_id = meeting_segments.meeting_id AND p.actor_id = speaker_id AND p.left_at IS NULL)));
CREATE POLICY meeting_segments_delete ON app.meeting_segments FOR DELETE USING ((SELECT app.is_system()));

ALTER TABLE app.meeting_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_presence FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_presence_select ON app.meeting_presence FOR SELECT
  USING ((SELECT app.is_system()) OR actor_id = (SELECT app.actor()));
CREATE POLICY meeting_presence_insert ON app.meeting_presence FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (actor_id = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL
      AND EXISTS (SELECT 1 FROM app.meeting_participants p WHERE p.meeting_id = meeting_presence.meeting_id AND p.actor_id = actor_id AND p.left_at IS NULL)));
CREATE POLICY meeting_presence_update ON app.meeting_presence FOR UPDATE
  USING ((SELECT app.is_system()) OR actor_id = (SELECT app.actor()))
  WITH CHECK ((SELECT app.is_system()) OR actor_id = (SELECT app.actor()));
CREATE POLICY meeting_presence_delete ON app.meeting_presence FOR DELETE
  USING ((SELECT app.is_system()) OR actor_id = (SELECT app.actor()));

GRANT SELECT, INSERT, UPDATE ON app.meetings TO manythreads_app;
GRANT SELECT, INSERT, UPDATE ON app.meeting_participants TO manythreads_app;
GRANT SELECT, INSERT ON app.meeting_segments TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.meeting_presence TO manythreads_app;

-- The definer functions run as the system role, so they pass the system policies above (and only those).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meetings_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.meeting_participants_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.meeting_participants_guard() OWNER TO manythreads_system;
ALTER FUNCTION app.meeting_participants_track() OWNER TO manythreads_system;
ALTER FUNCTION app.meeting_segments_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_end(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
