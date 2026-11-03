-- meetings 0002: consent and the transcription switch (PLAN P15-05). Forward-only: never edit once applied.
--
--   meetings.transcription_by   who turned the room's transcription on (null while it is off), so everyone in the room can see it.
--   meeting_settings            one row per workspace: the most a voice room may turn on (the workspace switch). A team's TEAM.md can lower it for that team.
--   app.meetings_set_transcription(meeting, mode)
--                               turns transcription on or off. Anyone present in the room may turn it on; turning it on asks everybody present again
--                               ("Transcribe my voice"); turning it off is for the person who turned it on, the starter and organizer, and anyone who manages the
--                               channel or team. The plugin has already checked the caps before it calls this.
--   app.meetings_set_consent(meeting, answer)
--                               a person's own answer. Answering no also blanks the words already stored for them.
--   meeting_segments            a line from a person who has not answered yes is stored without its words (only its times), and no line is taken while the
--                               room's transcription is off. A line is text only when its speaker said yes at that moment.

ALTER TABLE app.meetings ADD COLUMN transcription_by uuid REFERENCES app.actors (id) ON DELETE SET NULL;
CREATE INDEX meetings_transcription_by ON app.meetings (transcription_by) WHERE transcription_by IS NOT NULL;

-- The workspace switch ------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.meeting_settings (
  workspace_id   uuid PRIMARY KEY REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- the most a room may turn on: off forbids transcription, on_device allows each person's own device, server also allows the server fallback
  transcribe_cap text NOT NULL DEFAULT 'on_device' CHECK (transcribe_cap IN ('on_device', 'server', 'off')),
  updated_by     uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_settings_updated_by ON app.meeting_settings (updated_by) WHERE updated_by IS NOT NULL;
COMMENT ON TABLE app.meeting_settings IS 'rls: workspace — W: the most a voice room may turn on for transcription; readable by every member of the workspace, written by workspace owners and admins.';

ALTER TABLE app.meeting_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_settings_select ON app.meeting_settings FOR SELECT
  USING ((SELECT app.is_system()) OR workspace_id = (SELECT app.workspace_id()));
CREATE POLICY meeting_settings_insert ON app.meeting_settings FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY meeting_settings_update ON app.meeting_settings FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT ON app.meeting_settings TO manythreads_app;
GRANT INSERT (workspace_id, transcribe_cap, updated_by, updated_at) ON app.meeting_settings TO manythreads_app;
GRANT UPDATE (transcribe_cap, updated_by, updated_at) ON app.meeting_settings TO manythreads_app;

-- Turning transcription on or off ---------------------------------------------------------------------------------------------------------------------------
-- Returns false when the room already had that setting. Turning it on makes everybody present answer again; people who left keep the answer they gave, so their
-- earlier words stay as they were. The caps are the plugin's to check (TEAM.md is in the team's repository, not in the database).
CREATE FUNCTION app.meetings_set_transcription(p_meeting_id uuid, p_mode text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
  v_actor uuid := app.actor();
BEGIN
  IF p_mode NOT IN ('off', 'on_device', 'server') THEN
    RAISE EXCEPTION 'unknown transcription mode' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO m FROM app.meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND OR m.workspace_id <> app.workspace_id() THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_actor IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'only a person in the room changes its transcription' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.meeting_participants WHERE meeting_id = m.id AND actor_id = v_actor AND left_at IS NULL) THEN
    RAISE EXCEPTION 'join the voice room first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.transcription = p_mode THEN
    RETURN false;
  END IF;
  IF p_mode <> 'off' THEN
    IF m.transcription <> 'off' THEN
      RAISE EXCEPTION 'turn transcription off before changing how it works' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE app.meetings SET transcription = p_mode, transcription_by = v_actor WHERE id = m.id;
    UPDATE app.meeting_participants SET consent_transcribe = 'unasked' WHERE meeting_id = m.id AND left_at IS NULL;
  ELSE
    IF v_actor NOT IN (m.started_by, m.organizer_id) AND v_actor IS DISTINCT FROM m.transcription_by
       AND NOT coalesce(CASE WHEN m.channel_id IS NOT NULL THEN app.lookup_channel_can(m.channel_id, 'manage') ELSE app.lookup_can_team(m.team_id, 'manage') END, false) THEN
      RAISE EXCEPTION 'only the person who turned transcription on, the starter or a team lead can turn it off' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE app.meetings SET transcription = 'off', transcription_by = NULL WHERE id = m.id;
  END IF;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.meetings_set_transcription(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_set_transcription(uuid, text) TO manythreads_app, manythreads_system;

-- A person's own answer --------------------------------------------------------------------------------------------------------------------------------------
-- Only for the caller's own row, while they are in a live room. "No" blanks the words already stored for them: a line keeps its times (it is shown as
-- "<name> spoke (not transcribed)") and loses its text. Returns the answer now stored.
CREATE FUNCTION app.meetings_set_consent(p_meeting_id uuid, p_answer text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
  v_actor uuid := app.actor();
BEGIN
  IF p_answer NOT IN ('yes', 'no') THEN
    RAISE EXCEPTION 'answer yes or no' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO m FROM app.meetings WHERE id = p_meeting_id FOR SHARE;
  IF NOT FOUND OR m.workspace_id <> app.workspace_id() THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_actor IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'only a person answers for themself' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.meeting_participants SET consent_transcribe = p_answer
   WHERE meeting_id = m.id AND actor_id = v_actor AND left_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'join the voice room first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_answer = 'no' THEN
    UPDATE app.meeting_segments SET text = '' WHERE meeting_id = m.id AND speaker_id = v_actor AND text <> '';
  END IF;
  RETURN p_answer;
END
$$;
REVOKE ALL ON FUNCTION app.meetings_set_consent(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_set_consent(uuid, text) TO manythreads_app, manythreads_system;

-- Lines: the words of a person who has not said yes are never stored ------------------------------------------------------------------------------------------
CREATE POLICY meeting_segments_update ON app.meeting_segments FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

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
  IF m.state <> 'live' AND session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  NEW.channel_id := m.channel_id;
  NEW.team_id := m.team_id;
  IF session_user <> 'manythreads_system' THEN
    IF m.transcription = 'off' THEN
      RAISE EXCEPTION 'transcription is not on in this voice room' USING ERRCODE = 'check_violation';
    END IF;
    SELECT consent_transcribe INTO v_consent FROM app.meeting_participants WHERE meeting_id = NEW.meeting_id AND actor_id = NEW.speaker_id;
    -- whoever has not said yes leaves only the times of their speaking, never the words
    IF v_consent IS DISTINCT FROM 'yes' THEN
      NEW.text := '';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meetings_set_transcription(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_set_consent(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
