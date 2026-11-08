-- meetings 0004: an organizer who left the place of the call no longer reaches the team's copy of its notes (review P15-RV).
-- Forward-only: never edit once applied.
--
-- 0003 let the organizer read a meeting's notes row, and pass `app.meetings_can_read_notes`, whatever the location. That is right for a note-taker meeting's Personal copy (it is the
-- organizer's own file) but wrong for the copy written for the team (`repo`, `channel_files`): a person removed from a private channel, or from the team, kept reading the notes
-- of every call they had started there, and the notes routes (which trust that function) let them edit the team's notes file. From here the organizer reaches a non-Personal copy only
-- as long as they can still read the place the call happened in, like everyone else.

DROP POLICY meeting_notes_select ON app.meeting_notes;
CREATE POLICY meeting_notes_select ON app.meeting_notes FOR SELECT USING (
  (SELECT app.is_system())
  OR (organizer_id = (SELECT app.actor()) AND location = 'personal')
  OR (location <> 'personal'
      AND (channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
           OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])))));

CREATE OR REPLACE FUNCTION app.meetings_can_read_notes(p_meeting_id uuid) RETURNS boolean
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
  -- still a reader of the place the meeting happened in: its channel (a DM's members, a private channel's members), else its team
  v_in_place := coalesce(CASE WHEN m.channel_id IS NOT NULL THEN app.lookup_channel_can(m.channel_id, 'read') ELSE app.lookup_can_team(m.team_id, 'read') END, false);
  SELECT * INTO n FROM app.meeting_notes WHERE meeting_id = m.id;
  IF m.organizer_id = v_actor THEN
    -- the organizer's own Personal copy (or the one a note-taker is about to write) is theirs wherever they are; the team's copy only while they can read the place
    RETURN v_in_place OR (FOUND AND n.location = 'personal') OR (NOT FOUND AND m.notetaker_bot_id IS NOT NULL);
  END IF;
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
