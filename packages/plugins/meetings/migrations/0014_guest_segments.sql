-- meetings 0014: a link guest's own transcript lines, and turning off one guest link (PLAN P17-04 step 2, docs/plans/guest-links.md). Forward-only: never edit once applied.
--
-- A link guest (someone outside the workspace who joined through a guest link, migration 0012) is asked "Transcribe my voice?" like a person in the call. A guest who
-- says yes is written down by their own device only (never by the server or the note-taker), and the lines are stored with `guest_id` in place of `speaker_id`.
-- A guest who says no, or does not answer, is never written down. Recording is unchanged: it still counts every guest as a "no".
--
--   meeting_guests.consent_transcribe   the guest's answer: unasked, yes or no. Reset to unasked when the call's transcription is turned on again, as for people.
--   meeting_segments.guest_id           the guest who spoke the line (speaker_id is then null; exactly one of the two is set). Written only by the system role (the
--                                       guest's routes run as the system), only while the call is live and transcribed, and with words only for a guest let in
--                                       who said yes (the insert trigger blanks the rest, a second guard behind the route).
--   app.meetings_revoke_guest_link      the starter, a lead or an admin turns off one link of a live call; the others keep working.

-- 1. the guest's answer -------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.meeting_guests ADD COLUMN consent_transcribe text NOT NULL DEFAULT 'unasked' CHECK (consent_transcribe IN ('unasked', 'yes', 'no'));
GRANT SELECT (consent_transcribe) ON app.meeting_guests TO manythreads_app;

-- Turning transcription on asks everybody in the call again (0002 does it for people): the guests let in answer again too. A definer owned by the system role, as
-- every writer of app.meeting_guests.
CREATE FUNCTION app.meetings_guests_on_transcription() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.meeting_guests g SET consent_transcribe = 'unasked' WHERE g.meeting_id = NEW.id AND g.state = 'admitted' AND g.consent_transcribe <> 'unasked';
  RETURN NULL;
END
$$;
CREATE TRIGGER meetings_guests_on_transcription AFTER UPDATE OF transcription ON app.meetings FOR EACH ROW
  WHEN (OLD.transcription = 'off' AND NEW.transcription <> 'off') EXECUTE FUNCTION app.meetings_guests_on_transcription();

-- 2. lines of a guest -----------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.meeting_segments ALTER COLUMN speaker_id DROP NOT NULL;
ALTER TABLE app.meeting_segments ADD COLUMN guest_id uuid REFERENCES app.meeting_guests (id) ON DELETE CASCADE;
ALTER TABLE app.meeting_segments ADD CONSTRAINT meeting_segments_one_speaker CHECK (num_nonnulls(speaker_id, guest_id) = 1);
-- a guest's device sends a line twice, it is stored once (the people's constraint never matches a null speaker)
CREATE UNIQUE INDEX meeting_segments_guest_seg ON app.meeting_segments (meeting_id, guest_id, client_seg_id) WHERE guest_id IS NOT NULL;
CREATE INDEX meeting_segments_guest ON app.meeting_segments (guest_id) WHERE guest_id IS NOT NULL;
COMMENT ON COLUMN app.meeting_segments.guest_id IS 'the link guest who spoke the line (P17-04); speaker_id is null then. Written only by the system role for a guest let in who said yes.';

-- The insert trigger, as 0003 left it, with a guest's line: only the system role writes one (the guest's routes), as a device line, of a guest of this call, while the
-- call is live and transcribed; the words stay only for a guest who is let in and said yes.
CREATE OR REPLACE FUNCTION app.meeting_segments_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
  v_consent text;
  g record;
BEGIN
  SELECT * INTO m FROM app.meetings WHERE id = NEW.meeting_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.channel_id := m.channel_id;
  NEW.team_id := m.team_id;
  IF NEW.guest_id IS NOT NULL THEN
    IF session_user <> 'manythreads_system' OR NEW.speaker_id IS NOT NULL OR NEW.source <> 'device' THEN
      RAISE EXCEPTION 'only the guest routes write a guest''s line' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT x.meeting_id, x.state, x.consent_transcribe INTO g FROM app.meeting_guests x WHERE x.id = NEW.guest_id;
    IF NOT FOUND OR g.meeting_id <> NEW.meeting_id THEN
      RAISE EXCEPTION 'no such guest' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF m.state <> 'live' THEN
      RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
    END IF;
    IF m.transcription = 'off' THEN
      RAISE EXCEPTION 'transcription is not on in this voice room' USING ERRCODE = 'check_violation';
    END IF;
    IF g.state <> 'admitted' OR g.consent_transcribe IS DISTINCT FROM 'yes' THEN
      NEW.text := '';
    END IF;
    RETURN NEW;
  END IF;
  IF session_user <> 'manythreads_system' AND m.state <> 'live' AND now() > m.ended_at + interval '120 seconds' THEN
    RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
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

-- A person corrects only their own line: a guest's line (no speaker) is nobody's to correct. As 0003, with the comparison made null-safe.
CREATE OR REPLACE FUNCTION app.meetings_correct_segment(p_segment_id uuid, p_text text) RETURNS boolean
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
  IF NOT FOUND OR s.speaker_id IS DISTINCT FROM v_actor OR NOT EXISTS (SELECT 1 FROM app.meetings m WHERE m.id = s.meeting_id AND m.workspace_id = app.workspace_id()) THEN
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

-- 3. turn off one guest link ----------------------------------------------------------------------------------------------------------------------------------
-- The same people as for turning every link off (0012): the starter, a lead of the channel's team or a workspace admin, for a live call they can read. Only that link
-- stops; guest links stay on for the call. Returns true when the link was still working (an expired or used-up one is marked too, and answers false).
CREATE FUNCTION app.meetings_revoke_guest_link(p_meeting_id uuid, p_link_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m        record;
  l        app.meeting_guest_links;
  v_ws     uuid := app.workspace_id();
  v_caller uuid := app.actor();
BEGIN
  IF session_user = 'manythreads_system' OR v_ws IS NULL OR v_caller IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'Only a person can turn a guest link off' USING ERRCODE = 'insufficient_privilege';
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
  SELECT x.* INTO l FROM app.meeting_guest_links x WHERE x.id = p_link_id AND x.meeting_id = m.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such link' USING ERRCODE = 'no_data_found';
  END IF;
  IF l.revoked_at IS NOT NULL THEN
    RETURN false;
  END IF;
  UPDATE app.meeting_guest_links x SET revoked_at = now(), revoked_by = v_caller WHERE x.id = l.id;
  RETURN l.expires_at > now() AND l.uses < l.max_uses;
END
$$;

-- 4. owners and rights -----------------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meetings_guests_on_transcription() OWNER TO manythreads_system;
ALTER FUNCTION app.meeting_segments_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_correct_segment(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_revoke_guest_link(uuid, uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.meetings_guests_on_transcription() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.meetings_revoke_guest_link(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_revoke_guest_link(uuid, uuid) TO manythreads_app;
