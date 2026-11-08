-- meetings 0003: transcripts, notes, the note-taker, sharing and recording (PLAN P15-08 to P15-24, docs/plugins/meetings.md "Bundle C contracts").
-- Forward-only: never edit once applied.
--
--   meeting_segments     + client_seg_id (a device sends a line twice, it is stored once) and edited_at (a speaker corrected their own line); a line is taken until two
--                        minutes after the room ended; a line the server wrote (source `server`) is the system role's alone and, like a device's, carries words only for
--                        a speaker who said yes; a BRIN index on created_at (append-only).
--   meeting_notes        one row per meeting: where the transcript and notes were written, the notes text, the items found, the state, and whether they were saved to the team.
--   meeting_shares       the organizer's grants of the notes to a person or a channel; revocable.
--   meeting_recordings   one row per person's recorded audio.
--   meeting_settings     + room_cap, recording_cap, notetaker_allowed (the workspace switches).
--   meetings             + notetaker_by, recording_by (who added the note-taker, who turned recording on).
--   functions            app.meetings_correct_segment, app.meetings_set_notetaker, app.meetings_set_recording, app.meetings_can_read_notes.

-- Lines ----------------------------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.meeting_segments ADD COLUMN client_seg_id text CHECK (client_seg_id IS NULL OR char_length(client_seg_id) BETWEEN 1 AND 64);
ALTER TABLE app.meeting_segments ADD COLUMN edited_at timestamptz;
-- NULLs are distinct, so lines without a client id (the server's own) never collide; a device's line is unique by speaker and id.
ALTER TABLE app.meeting_segments ADD CONSTRAINT meeting_segments_client_seg UNIQUE (meeting_id, speaker_id, client_seg_id);
CREATE INDEX meeting_segments_created_brin ON app.meeting_segments USING brin (created_at);
CREATE INDEX meeting_segments_text_trgm ON app.meeting_segments USING gin (text gin_trgm_ops);

-- The insert policy: a person's device writes only its own line; the person must be in the room, or must have left it less than two minutes ago (a final line
-- can still be on its way when someone presses Leave). The room's own late window is the trigger's below.
DROP POLICY meeting_segments_insert ON app.meeting_segments;
CREATE POLICY meeting_segments_insert ON app.meeting_segments FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (speaker_id = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL AND source = 'device'
      AND EXISTS (SELECT 1 FROM app.meeting_participants p
                   WHERE p.meeting_id = meeting_segments.meeting_id AND p.actor_id = speaker_id
                     AND (p.left_at IS NULL OR p.left_at > now() - interval '120 seconds'))));

-- The insert trigger, as 0002 left it, with the late window: a room that ended up to two minutes ago still takes lines (the speakers' devices are catching up), and a
-- line the server wrote about a person carries words only when that person said yes. The strip of control characters stays in the plugin; the CHECK on `text` keeps the length.
CREATE OR REPLACE FUNCTION app.meeting_segments_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
  v_consent text;
BEGIN
  SELECT * INTO m FROM app.meetings WHERE id = NEW.meeting_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF session_user <> 'manythreads_system' AND m.state <> 'live' AND now() > m.ended_at + interval '120 seconds' THEN
    RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  NEW.channel_id := m.channel_id;
  NEW.team_id := m.team_id;
  IF session_user <> 'manythreads_system' AND m.transcription = 'off' THEN
    RAISE EXCEPTION 'transcription is not on in this voice room' USING ERRCODE = 'check_violation';
  END IF;
  IF session_user <> 'manythreads_system' OR NEW.source = 'server' THEN
    SELECT consent_transcribe INTO v_consent FROM app.meeting_participants WHERE meeting_id = NEW.meeting_id AND actor_id = NEW.speaker_id;
    -- whoever has not said yes leaves only the times of their speaking, never the words
    IF v_consent IS DISTINCT FROM 'yes' THEN
      NEW.text := '';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- A speaker corrects the words of their own line, for 24 hours after the line was stored, and only while they still say yes. The new text is already cleaned by the
-- plugin (control characters stripped). Returns false when the line is not theirs, is too old, or has no words to correct.
CREATE FUNCTION app.meetings_correct_segment(p_segment_id uuid, p_text text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  s app.meeting_segments;
  v_actor uuid := app.actor();
  v_consent text;
BEGIN
  IF v_actor IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'only a person corrects their own words' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_text IS NULL OR char_length(btrim(p_text)) = 0 OR char_length(p_text) > 4000 THEN
    RAISE EXCEPTION 'write the corrected words (up to 4000 characters)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO s FROM app.meeting_segments WHERE id = p_segment_id FOR UPDATE;
  IF NOT FOUND OR s.speaker_id <> v_actor OR NOT EXISTS (SELECT 1 FROM app.meetings m WHERE m.id = s.meeting_id AND m.workspace_id = app.workspace_id()) THEN
    RETURN false;
  END IF;
  IF s.created_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'A line can be corrected for 24 hours' USING ERRCODE = 'check_violation';
  END IF;
  SELECT consent_transcribe INTO v_consent FROM app.meeting_participants WHERE meeting_id = s.meeting_id AND actor_id = v_actor;
  IF v_consent IS DISTINCT FROM 'yes' OR s.text = '' THEN
    RETURN false;
  END IF;
  UPDATE app.meeting_segments SET text = p_text, edited_at = now() WHERE id = s.id;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.meetings_correct_segment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_correct_segment(uuid, text) TO manythreads_app, manythreads_system;

-- Settings and room columns ----------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.meeting_settings ADD COLUMN room_cap integer NOT NULL DEFAULT 25 CHECK (room_cap BETWEEN 2 AND 100);
ALTER TABLE app.meeting_settings ADD COLUMN recording_cap text NOT NULL DEFAULT 'off' CHECK (recording_cap IN ('off', 'on'));
ALTER TABLE app.meeting_settings ADD COLUMN notetaker_allowed boolean NOT NULL DEFAULT true;
GRANT INSERT (room_cap, recording_cap, notetaker_allowed) ON app.meeting_settings TO manythreads_app;
GRANT UPDATE (room_cap, recording_cap, notetaker_allowed) ON app.meeting_settings TO manythreads_app;

ALTER TABLE app.meetings ADD COLUMN notetaker_by uuid REFERENCES app.actors (id) ON DELETE SET NULL;
ALTER TABLE app.meetings ADD COLUMN recording_by uuid REFERENCES app.actors (id) ON DELETE SET NULL;
CREATE INDEX meetings_notetaker_by ON app.meetings (notetaker_by) WHERE notetaker_by IS NOT NULL;
CREATE INDEX meetings_recording_by ON app.meetings (recording_by) WHERE recording_by IS NOT NULL;

-- The room can be seen at a glance: a fresh room has no note-taker and no recording, whoever inserts it.
CREATE OR REPLACE FUNCTION app.meetings_before_insert() RETURNS trigger
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
    NEW.notetaker_by := NULL;
    NEW.transcription := 'off';
    NEW.recording := false;
    NEW.recording_by := NULL;
    NEW.transcript_path := NULL;
    NEW.transcript_file_id := NULL;
    NEW.empty_since := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- Notes ------------------------------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.meeting_notes (
  meeting_id       uuid PRIMARY KEY REFERENCES app.meetings (id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- copied from the meeting, so the policy can probe the visibility sets without reading the meeting
  team_id          uuid,
  channel_id       uuid,
  organizer_id     uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  -- repo: the team repo `meetings/...` (a public channel); channel_files: the channel's Files folder (a private channel or a DM); personal: the organizer's Personal space (a note-taker)
  location         text NOT NULL CHECK (location IN ('repo', 'channel_files', 'personal')),
  transcript_path  text CHECK (transcript_path IS NULL OR char_length(transcript_path) <= 500),
  notes_path       text CHECK (notes_path IS NULL OR char_length(notes_path) <= 500),
  -- the Files rows of the written files (a private or Personal copy); empty for the repo
  file_ids         uuid[] NOT NULL DEFAULT '{}',
  summary          text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 4000),
  notes_md         text NOT NULL DEFAULT '' CHECK (char_length(notes_md) <= 200000),
  -- the decisions, action items and questions found: an array of MeetingNoteItem (packages/shared/src/entities/meeting.ts)
  items            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items) = 'array'),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'written', 'failed')),
  failure          text CHECK (failure IS NULL OR char_length(failure) <= 500),
  -- the memory inbox item the notes were filed as (a table of another plugin: no foreign key)
  memory_item_id   uuid,
  -- saved to the team's meeting notes (P15-23): when, by whom, and the team folder
  saved_at         timestamptz,
  saved_by         uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  saved_path       text CHECK (saved_path IS NULL OR char_length(saved_path) <= 500),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_notes_saved_shape CHECK ((saved_at IS NULL) = (saved_path IS NULL))
);
CREATE INDEX meeting_notes_workspace ON app.meeting_notes (workspace_id);
CREATE INDEX meeting_notes_organizer ON app.meeting_notes (organizer_id);
CREATE INDEX meeting_notes_saved_by ON app.meeting_notes (saved_by) WHERE saved_by IS NOT NULL;
CREATE INDEX meeting_notes_text_trgm ON app.meeting_notes USING gin (notes_md gin_trgm_ops);
COMMENT ON TABLE app.meeting_notes IS 'rls: team — C: where a meeting''s transcript and notes are written and the notes text; readable by whoever can read the room''s channel (or team), except a note-taker meeting''s Personal copy, which only its organizer reads (others read through app.meetings_can_read_notes); written only by the system role (the plugin''s jobs and routes).';

CREATE FUNCTION app.meeting_notes_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
BEGIN
  SELECT * INTO m FROM app.meetings WHERE id = NEW.meeting_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.workspace_id := m.workspace_id;
  NEW.team_id := m.team_id;
  NEW.channel_id := m.channel_id;
  NEW.organizer_id := m.organizer_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER meeting_notes_before_insert BEFORE INSERT ON app.meeting_notes FOR EACH ROW EXECUTE FUNCTION app.meeting_notes_before_insert();

ALTER TABLE app.meeting_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_notes_select ON app.meeting_notes FOR SELECT USING (
  (SELECT app.is_system())
  OR organizer_id = (SELECT app.actor())
  OR (location <> 'personal'
      AND (channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
           OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])))));
CREATE POLICY meeting_notes_insert ON app.meeting_notes FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_notes_update ON app.meeting_notes FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_notes_delete ON app.meeting_notes FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.meeting_notes TO manythreads_app;

-- Shares -----------------------------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.meeting_shares (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id         uuid NOT NULL REFERENCES app.meetings (id) ON DELETE CASCADE,
  workspace_id       uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  grantee_kind       text NOT NULL CHECK (grantee_kind IN ('person', 'channel')),
  grantee_person_id  uuid REFERENCES app.people (id) ON DELETE CASCADE,
  grantee_channel_id uuid REFERENCES app.channels (id) ON DELETE CASCADE,
  created_by         uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  CONSTRAINT meeting_shares_grantee_shape CHECK (
    (grantee_kind = 'person' AND grantee_person_id IS NOT NULL AND grantee_channel_id IS NULL)
    OR (grantee_kind = 'channel' AND grantee_channel_id IS NOT NULL AND grantee_person_id IS NULL))
);
CREATE INDEX meeting_shares_meeting ON app.meeting_shares (meeting_id);
CREATE INDEX meeting_shares_workspace ON app.meeting_shares (workspace_id);
CREATE INDEX meeting_shares_person ON app.meeting_shares (grantee_person_id) WHERE grantee_person_id IS NOT NULL;
CREATE INDEX meeting_shares_channel ON app.meeting_shares (grantee_channel_id) WHERE grantee_channel_id IS NOT NULL;
CREATE INDEX meeting_shares_created_by ON app.meeting_shares (created_by);
CREATE UNIQUE INDEX meeting_shares_one_person ON app.meeting_shares (meeting_id, grantee_person_id) WHERE revoked_at IS NULL AND grantee_person_id IS NOT NULL;
CREATE UNIQUE INDEX meeting_shares_one_channel ON app.meeting_shares (meeting_id, grantee_channel_id) WHERE revoked_at IS NULL AND grantee_channel_id IS NOT NULL;
COMMENT ON TABLE app.meeting_shares IS 'rls: person — P: the organizer''s grants of a meeting''s notes to a person or a channel; the organizer and the grantee read a grant, only the organizer makes or revokes one (a revoked grant is kept, never deleted by a person).';

-- The workspace and the grantor come from the meeting; only the organizer of a meeting in the caller's workspace grants; a person grantee is a person of the workspace, a channel
-- grantee a channel of it. A revoke is the only change: nothing but `revoked_at` moves, and only from null.
CREATE FUNCTION app.meeting_shares_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
BEGIN
  SELECT * INTO m FROM app.meetings WHERE id = NEW.meeting_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.workspace_id := m.workspace_id;
  NEW.created_at := now();
  NEW.revoked_at := NULL;
  IF session_user <> 'manythreads_system' THEN
    IF m.organizer_id <> app.actor() THEN
      RAISE EXCEPTION 'only the organizer shares the notes' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_by := app.actor();
  END IF;
  IF NEW.grantee_person_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.people p WHERE p.id = NEW.grantee_person_id AND p.workspace_id = m.workspace_id) THEN
    RAISE EXCEPTION 'share with a person of this workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.grantee_channel_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.channels c WHERE c.id = NEW.grantee_channel_id AND c.workspace_id = m.workspace_id) THEN
    RAISE EXCEPTION 'share with a channel of this workspace' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER meeting_shares_before_insert BEFORE INSERT ON app.meeting_shares FOR EACH ROW EXECUTE FUNCTION app.meeting_shares_before_insert();

CREATE FUNCTION app.meeting_shares_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at') OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a share can only be revoked, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER meeting_shares_guard BEFORE UPDATE ON app.meeting_shares FOR EACH ROW EXECUTE FUNCTION app.meeting_shares_guard();

ALTER TABLE app.meeting_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_shares_select ON app.meeting_shares FOR SELECT USING (
  (SELECT app.is_system())
  OR created_by = (SELECT app.actor())
  OR grantee_person_id = (SELECT app.person_id()));
CREATE POLICY meeting_shares_insert ON app.meeting_shares FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (created_by = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY meeting_shares_update ON app.meeting_shares FOR UPDATE
  USING ((SELECT app.is_system()) OR created_by = (SELECT app.actor()))
  WITH CHECK ((SELECT app.is_system()) OR created_by = (SELECT app.actor()));
CREATE POLICY meeting_shares_delete ON app.meeting_shares FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.meeting_shares TO manythreads_app;
GRANT INSERT (meeting_id, grantee_kind, grantee_person_id, grantee_channel_id, created_by) ON app.meeting_shares TO manythreads_app;
GRANT UPDATE (revoked_at) ON app.meeting_shares TO manythreads_app;

-- Recordings -------------------------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.meeting_recordings (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id   uuid NOT NULL REFERENCES app.meetings (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid,
  channel_id   uuid,
  -- whose voice the file holds (the person who said yes to being recorded)
  actor_id     uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  file_id      uuid REFERENCES app.files (id) ON DELETE SET NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  stopped_at   timestamptz,
  stop_reason  text CHECK (stop_reason IN ('turned_off', 'left', 'ended', 'consent_withdrawn', 'joined_without_yes', 'failed')),
  CONSTRAINT meeting_recordings_stop_shape CHECK ((stopped_at IS NULL) = (stop_reason IS NULL))
);
CREATE INDEX meeting_recordings_meeting ON app.meeting_recordings (meeting_id, started_at);
CREATE INDEX meeting_recordings_workspace ON app.meeting_recordings (workspace_id);
CREATE INDEX meeting_recordings_actor ON app.meeting_recordings (actor_id);
CREATE INDEX meeting_recordings_file ON app.meeting_recordings (file_id) WHERE file_id IS NOT NULL;
COMMENT ON TABLE app.meeting_recordings IS 'rls: team — C: which people''s audio was recorded in a voice room and the Files row of each file; readable by whoever can read the room, written only by the system role (the listener).';

CREATE FUNCTION app.meeting_recordings_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
BEGIN
  SELECT * INTO m FROM app.meetings WHERE id = NEW.meeting_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.workspace_id := m.workspace_id;
  NEW.team_id := m.team_id;
  NEW.channel_id := m.channel_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER meeting_recordings_before_insert BEFORE INSERT ON app.meeting_recordings FOR EACH ROW EXECUTE FUNCTION app.meeting_recordings_before_insert();

ALTER TABLE app.meeting_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_recordings FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_recordings_select ON app.meeting_recordings FOR SELECT USING (
  (SELECT app.is_system())
  OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
  OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])));
CREATE POLICY meeting_recordings_insert ON app.meeting_recordings FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_recordings_update ON app.meeting_recordings FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_recordings_delete ON app.meeting_recordings FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.meeting_recordings TO manythreads_app;

-- The note-taker ---------------------------------------------------------------------------------------------------------------------------------------------------
-- p_bot_id set: add that bot as the room's note-taker. Anyone present may; a room has one; the bot must be an active bot of the room's team (or a workspace-wide bot of
-- the workspace). The plugin has already checked the bot's `meeting` trigger, the team's and the workspace's switches and that a server transcriber is bound (TEAM.md and
-- the model aliases are not in the database). The note-taker listens on the server, so the room's transcription moves to `server` and everybody present is asked again.
-- p_bot_id null: remove it; the organizer, the starter, the person who added it, a team lead or an admin may. Returns false when nothing changed.
CREATE FUNCTION app.meetings_set_notetaker(p_meeting_id uuid, p_bot_id uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
  b app.bots;
  v_actor uuid := app.actor();
BEGIN
  SELECT * INTO m FROM app.meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND OR m.workspace_id <> app.workspace_id() THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_actor IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'only a person in the room changes its note-taker' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  IF p_bot_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM app.meeting_participants WHERE meeting_id = m.id AND actor_id = v_actor AND left_at IS NULL) THEN
      RAISE EXCEPTION 'join the voice room first' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT * INTO b FROM app.bots WHERE id = p_bot_id AND workspace_id = m.workspace_id;
    IF NOT FOUND OR b.status <> 'active' OR NOT (coalesce(b.team_id = m.team_id, false) OR b.visibility = 'workspace') THEN
      RAISE EXCEPTION 'This bot cannot be the note-taker of this room' USING ERRCODE = 'check_violation';
    END IF;
    IF m.notetaker_bot_id = p_bot_id THEN
      RETURN false;
    END IF;
    IF m.notetaker_bot_id IS NOT NULL THEN
      RAISE EXCEPTION 'This room already has a note-taker' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE app.meetings
       SET notetaker_bot_id = p_bot_id, notetaker_by = v_actor, transcription = 'server', transcription_by = v_actor
     WHERE id = m.id;
    UPDATE app.meeting_participants SET consent_transcribe = 'unasked' WHERE meeting_id = m.id AND left_at IS NULL;
    RETURN true;
  END IF;
  IF m.notetaker_bot_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor NOT IN (m.organizer_id, m.started_by) AND v_actor IS DISTINCT FROM m.notetaker_by
     AND NOT coalesce(CASE WHEN m.channel_id IS NOT NULL THEN app.lookup_channel_can(m.channel_id, 'manage') ELSE app.lookup_can_team(m.team_id, 'manage') END, false) THEN
    RAISE EXCEPTION 'only the organizer, the person who added it or a team lead can remove the note-taker' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.meetings SET notetaker_bot_id = NULL, notetaker_by = NULL WHERE id = m.id;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.meetings_set_notetaker(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_set_notetaker(uuid, uuid) TO manythreads_app, manythreads_system;

-- Recording --------------------------------------------------------------------------------------------------------------------------------------------------------
-- Turning it on needs the workspace switch (`recording_cap` = on; TEAM.md is the plugin's to check), a person in the room, and asks everybody present again
-- ("Record my voice"). Turning it off: the person who turned it on, the organizer, the starter, a team lead or an admin. Returns false when the room already had that setting.
CREATE FUNCTION app.meetings_set_recording(p_meeting_id uuid, p_on boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
  v_actor uuid := app.actor();
  v_cap text;
BEGIN
  SELECT * INTO m FROM app.meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND OR m.workspace_id <> app.workspace_id() THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_actor IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'only a person in the room changes its recording' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  IF m.recording = p_on THEN
    RETURN false;
  END IF;
  IF p_on THEN
    IF NOT EXISTS (SELECT 1 FROM app.meeting_participants WHERE meeting_id = m.id AND actor_id = v_actor AND left_at IS NULL) THEN
      RAISE EXCEPTION 'join the voice room first' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT recording_cap INTO v_cap FROM app.meeting_settings WHERE workspace_id = m.workspace_id;
    IF coalesce(v_cap, 'off') <> 'on' THEN
      RAISE EXCEPTION 'Recording is switched off for this workspace' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE app.meetings SET recording = true, recording_by = v_actor WHERE id = m.id;
    UPDATE app.meeting_participants SET consent_record = 'unasked' WHERE meeting_id = m.id AND left_at IS NULL;
    RETURN true;
  END IF;
  IF v_actor NOT IN (m.organizer_id, m.started_by) AND v_actor IS DISTINCT FROM m.recording_by
     AND NOT coalesce(CASE WHEN m.channel_id IS NOT NULL THEN app.lookup_channel_can(m.channel_id, 'manage') ELSE app.lookup_can_team(m.team_id, 'manage') END, false) THEN
    RAISE EXCEPTION 'only the person who turned recording on, the organizer or a team lead can turn it off' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.meetings SET recording = false, recording_by = NULL WHERE id = m.id;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.meetings_set_recording(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_set_recording(uuid, boolean) TO manythreads_app, manythreads_system;

-- Who reads a meeting's notes ---------------------------------------------------------------------------------------------------------------------------------------
-- True for the caller when: they organized the meeting; or the notes sit in the team repo or the channel's Files (not a Personal copy) and they can read the room's channel
-- (or team); or the organizer saved them to the team and they can read the room's team; or an unrevoked share names them and they are still a reader of the meeting's
-- team (or still in the direct message), or names a channel they can read. Checked with the caller's own lookups, never the system role's reading (this function is
-- SECURITY DEFINER, where `app.is_system()` is true).
CREATE FUNCTION app.meetings_can_read_notes(p_meeting_id uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
  n app.meeting_notes;
  v_actor uuid := app.actor();
  v_person uuid := app.person_id();
  v_in_place boolean;
BEGIN
  IF v_actor IS NULL OR v_person IS NULL OR app.workspace_id() IS NULL THEN
    RETURN false;
  END IF;
  SELECT * INTO m FROM app.meetings WHERE id = p_meeting_id AND workspace_id = app.workspace_id();
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF m.organizer_id = v_actor THEN
    RETURN true;
  END IF;
  -- still a reader of the place the meeting happened in: its channel (a DM's members, a private channel's members), else its team
  v_in_place := coalesce(CASE WHEN m.channel_id IS NOT NULL THEN app.lookup_channel_can(m.channel_id, 'read') ELSE app.lookup_can_team(m.team_id, 'read') END, false);
  SELECT * INTO n FROM app.meeting_notes WHERE meeting_id = m.id;
  IF FOUND AND v_in_place AND (n.location <> 'personal' OR n.saved_at IS NOT NULL) THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM app.meeting_shares s
              WHERE s.meeting_id = m.id AND s.revoked_at IS NULL AND s.grantee_kind = 'person' AND s.grantee_person_id = v_person) AND v_in_place THEN
    RETURN true;
  END IF;
  RETURN EXISTS (SELECT 1 FROM app.meeting_shares s
                  WHERE s.meeting_id = m.id AND s.revoked_at IS NULL AND s.grantee_kind = 'channel'
                    AND coalesce(app.lookup_channel_can(s.grantee_channel_id, 'read'), false));
END
$$;
REVOKE ALL ON FUNCTION app.meetings_can_read_notes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_can_read_notes(uuid) TO manythreads_app, manythreads_system;

-- The definer functions run as the system role, so they pass the system policies (and only those).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meeting_segments_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_correct_segment(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.meeting_notes_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.meeting_shares_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.meeting_recordings_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_set_notetaker(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_set_recording(uuid, boolean) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_can_read_notes(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
