-- meetings 0005: rooms planned ahead on a person's calendar (PLAN Bundle D, P16-05). Forward-only: never edit once applied.
--
-- A SCHEDULED MEETING is a planned voice room: a title, a time, an agenda, the channel it belongs to and the calendar event that carries it at the person's own Google or Microsoft
-- calendar. It is not a room yet: a room is made when someone presses Start at the time (or opens the join link), and that room remembers which plan it came from.
--
--   scheduled_meetings            the plan. Channel readers read it; the organizer makes and cancels it through the two functions below; the platform's jobs (reminder, sync with
--                                 the calendar) change the rest. People outside the workspace who were invited are only a count: their addresses are never kept.
--   scheduled_meeting_attendees   the people of the workspace who were invited (person ids only). They are the ones the reminder tells.
--   meetings.scheduled_meeting_id the plan a room came from (null for an unplanned room). One live room per plan.
--
-- The room itself stays immutable after insert (0001's guard): the link to its plan is set at insert and validated by the insert trigger, which also marks the plan `started`.

CREATE TABLE app.scheduled_meetings (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id           uuid REFERENCES app.teams (id) ON DELETE CASCADE,
  channel_id        uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  organizer_id      uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  -- which calendar service carries the event, and which of the person's calendars (null: their main one)
  provider          text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  calendar_id       text CHECK (calendar_id IS NULL OR char_length(calendar_id) <= 500),
  -- the provider's id of the event; null only for a moment between the plan and the event
  external_event_id text CHECK (external_event_id IS NULL OR char_length(external_event_id) BETWEEN 1 AND 1024),
  title             text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120 AND title !~ '[\x01-\x1f\x7f-\x9f  ]'),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  agenda_md         text NOT NULL DEFAULT '' CHECK (char_length(agenda_md) <= 8000),
  status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'started')),
  -- invited people outside the workspace: a count only
  outside_count     integer NOT NULL DEFAULT 0 CHECK (outside_count BETWEEN 0 AND 50),
  -- when the five-minute reminder went out (once); when the calendar was last asked about this event
  reminded_at       timestamptz,
  synced_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_meetings_span CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '24 hours'),
  UNIQUE (id, channel_id)
);
CREATE INDEX scheduled_meetings_upcoming ON app.scheduled_meetings (starts_at) WHERE status = 'scheduled';
CREATE INDEX scheduled_meetings_channel ON app.scheduled_meetings (channel_id, starts_at);
CREATE INDEX scheduled_meetings_workspace ON app.scheduled_meetings (workspace_id);
CREATE INDEX scheduled_meetings_team ON app.scheduled_meetings (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX scheduled_meetings_organizer ON app.scheduled_meetings (organizer_id);
COMMENT ON TABLE app.scheduled_meetings IS 'rls: team — C: planned voice rooms of the channels the caller can read (app.visible_channel_ids); made and cancelled by the organizer through app.meetings_schedule / app.meetings_cancel_scheduled, changed by the platform''s jobs (system) only.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id ON app.scheduled_meetings
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

CREATE TABLE app.scheduled_meeting_attendees (
  scheduled_meeting_id uuid NOT NULL,
  person_id            uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id         uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- copied from the plan, so reading needs no join (the same set of channels as the plan)
  channel_id           uuid NOT NULL,
  PRIMARY KEY (scheduled_meeting_id, person_id),
  FOREIGN KEY (scheduled_meeting_id, channel_id) REFERENCES app.scheduled_meetings (id, channel_id) ON DELETE CASCADE
);
CREATE INDEX scheduled_meeting_attendees_person ON app.scheduled_meeting_attendees (person_id);
CREATE INDEX scheduled_meeting_attendees_channel ON app.scheduled_meeting_attendees (channel_id);
CREATE INDEX scheduled_meeting_attendees_workspace ON app.scheduled_meeting_attendees (workspace_id);
COMMENT ON TABLE app.scheduled_meeting_attendees IS 'rls: team — C: the people of the workspace invited to a planned room (person ids only), readable by whoever reads its channel; written only through app.meetings_schedule and the system role.';

ALTER TABLE app.meetings ADD COLUMN scheduled_meeting_id uuid REFERENCES app.scheduled_meetings (id) ON DELETE SET NULL;
CREATE INDEX meetings_scheduled ON app.meetings (scheduled_meeting_id) WHERE scheduled_meeting_id IS NOT NULL;
-- one live room per plan: two people pressing Start at once end up in the same room
CREATE UNIQUE INDEX meetings_one_live_per_scheduled ON app.meetings (scheduled_meeting_id) WHERE state = 'live' AND scheduled_meeting_id IS NOT NULL;

-- The room remembers its plan: what a new room may name -------------------------------------------------------------------------------------------
-- 0003's insert trigger, with one more rule: a room that names a plan must be in the plan's own channel, and the plan must still be `scheduled` (a cancelled or already started plan
-- cannot be opened a second time). Everything else is as in 0003.
CREATE OR REPLACE FUNCTION app.meetings_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  c app.channels;
  s app.scheduled_meetings;
BEGIN
  IF NEW.channel_id IS NOT NULL THEN
    SELECT * INTO c FROM app.channels WHERE id = NEW.channel_id;
    IF NOT FOUND OR c.workspace_id <> NEW.workspace_id THEN
      RAISE EXCEPTION 'a voice room belongs to a channel of the same workspace' USING ERRCODE = 'check_violation';
    END IF;
    NEW.team_id := c.team_id;
  END IF;
  IF NEW.scheduled_meeting_id IS NOT NULL THEN
    SELECT * INTO s FROM app.scheduled_meetings WHERE id = NEW.scheduled_meeting_id;
    IF NOT FOUND OR s.workspace_id <> NEW.workspace_id OR s.channel_id IS DISTINCT FROM NEW.channel_id THEN
      RAISE EXCEPTION 'a planned room can only be opened in its own channel' USING ERRCODE = 'check_violation';
    END IF;
    IF s.status <> 'scheduled' THEN
      RAISE EXCEPTION 'this planned room was cancelled or has already been opened' USING ERRCODE = 'check_violation';
    END IF;
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

-- Opening the room marks its plan `started`, whoever opened it.
CREATE FUNCTION app.meetings_mark_scheduled_started() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.scheduled_meetings SET status = 'started', updated_at = now() WHERE id = NEW.scheduled_meeting_id AND status = 'scheduled';
  RETURN NULL;
END
$$;
CREATE TRIGGER meetings_mark_scheduled_started AFTER INSERT ON app.meetings
  FOR EACH ROW WHEN (NEW.scheduled_meeting_id IS NOT NULL) EXECUTE FUNCTION app.meetings_mark_scheduled_started();

-- Make a plan -----------------------------------------------------------------------------------------------------------------------------------------
-- The caller (a person) must be able to post in the channel. `p_id` is the id the join link already names (the event is made at the provider first, so the link can be in it); null
-- makes one. Attendees are person ids: each must be an active person who can read the channel now; any that cannot are counted with the outsiders instead (a non-reader never gets
-- the link). At most 50 invited in all, and at most 100 plans waiting in one channel.
CREATE FUNCTION app.meetings_schedule(
  p_id uuid, p_channel_id uuid, p_title text, p_starts_at timestamptz, p_ends_at timestamptz, p_agenda_md text,
  p_provider text, p_calendar_id text, p_external_event_id text, p_attendee_person_ids uuid[], p_outside_count integer
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws       uuid := app.workspace_id();
  v_caller   uuid := app.actor();
  v_team     uuid;
  v_archived timestamptz;
  v_id       uuid := coalesce(p_id, uuidv7());
  v_readers  uuid[];
  v_in       uuid[];
  v_dropped  integer;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    IF v_ws IS NULL OR v_caller IS NULL OR app.person_id() IS NULL OR NOT coalesce(app.lookup_channel_can(p_channel_id, 'post'), false) THEN
      RAISE EXCEPTION 'only someone who can post in the channel can plan a room there' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT c.team_id, c.archived_at, c.workspace_id INTO v_team, v_archived, v_ws FROM app.channels c WHERE c.id = p_channel_id AND c.workspace_id = coalesce(v_ws, c.workspace_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such channel' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'This channel is archived, so no room can be planned in it' USING ERRCODE = 'check_violation';
  END IF;
  IF p_starts_at > now() + interval '366 days' THEN
    RAISE EXCEPTION 'A room can be planned at most a year ahead' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM app.scheduled_meetings s WHERE s.channel_id = p_channel_id AND s.status = 'scheduled' AND s.ends_at > now()) >= 100 THEN
    RAISE EXCEPTION 'A channel can have at most 100 planned rooms waiting. Cancel one you no longer need.' USING ERRCODE = 'check_violation';
  END IF;
  -- who of the named people can read the channel now
  SELECT coalesce(array_agg(au.person_id), ARRAY[]::uuid[]) INTO v_readers FROM app.channel_audience(p_channel_id) au;
  SELECT coalesce(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_in FROM unnest(coalesce(p_attendee_person_ids, ARRAY[]::uuid[])) x WHERE x = ANY (v_readers);
  v_dropped := cardinality(coalesce(p_attendee_person_ids, ARRAY[]::uuid[])) - cardinality(v_in);
  IF cardinality(v_in) + coalesce(p_outside_count, 0) + greatest(v_dropped, 0) > 50 THEN
    RAISE EXCEPTION 'A planned room can have at most 50 people invited' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.scheduled_meetings (id, workspace_id, team_id, channel_id, organizer_id, provider, calendar_id, external_event_id, title, starts_at, ends_at, agenda_md, outside_count)
    VALUES (v_id, v_ws, v_team, p_channel_id, coalesce(v_caller, (SELECT c.created_by FROM app.channels c WHERE c.id = p_channel_id)), p_provider, p_calendar_id, p_external_event_id,
            btrim(p_title), p_starts_at, p_ends_at, coalesce(p_agenda_md, ''), greatest(coalesce(p_outside_count, 0), 0) + greatest(v_dropped, 0));
  INSERT INTO app.scheduled_meeting_attendees (scheduled_meeting_id, person_id, workspace_id, channel_id)
    SELECT v_id, x, v_ws, p_channel_id FROM unnest(v_in) x;
  RETURN v_id;
END
$$;

-- Cancel a plan: its organizer (or the system role) while it is still waiting. Answers false when there was nothing to cancel.
CREATE FUNCTION app.meetings_cancel_scheduled(p_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    IF app.actor() IS NULL OR app.workspace_id() IS NULL THEN
      RETURN false;
    END IF;
    UPDATE app.scheduled_meetings s SET status = 'cancelled', updated_at = now()
     WHERE s.id = p_id AND s.status = 'scheduled' AND s.organizer_id = app.actor() AND s.workspace_id = app.workspace_id();
  ELSE
    UPDATE app.scheduled_meetings s SET status = 'cancelled', updated_at = now() WHERE s.id = p_id AND s.status = 'scheduled';
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$$;

-- The join page for someone who may not read the channel ---------------------------------------------------------------------------------------
-- `/join/<id>` has to say something to a person who cannot read the room's channel ("You are not in #design. Ask Nadia to add you."). The id is a link someone was given, so this answers
-- only that and nothing else: whether the caller can read the channel, the plan's state, the organizer's name, and the channel's name when it is a public channel (a private
-- channel's name is not given to a non-reader). Any signed-in person of the workspace may ask.
CREATE FUNCTION app.meetings_scheduled_gate(p_id uuid)
  RETURNS TABLE (readable boolean, status text, channel_name text, organizer_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s app.scheduled_meetings;
  c app.channels;
  v_read boolean;
BEGIN
  IF app.actor() IS NULL OR app.workspace_id() IS NULL OR app.lookup_workspace_role() IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO s FROM app.scheduled_meetings WHERE id = p_id AND workspace_id = app.workspace_id();
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO c FROM app.channels WHERE id = s.channel_id;
  v_read := coalesce(app.lookup_channel_can(s.channel_id, 'read'), false);
  RETURN QUERY
  SELECT v_read, s.status, CASE WHEN v_read OR NOT c.private THEN c.name END,
         (SELECT p.display_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id WHERE a.id = s.organizer_id AND a.kind = 'person');
END
$$;

-- Row level security ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.scheduled_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scheduled_meetings FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_meetings_select ON app.scheduled_meetings FOR SELECT USING (
  (SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
);
-- written by the two functions above (they run as the system role) and by the platform's jobs
CREATE POLICY scheduled_meetings_insert ON app.scheduled_meetings FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY scheduled_meetings_update ON app.scheduled_meetings FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY scheduled_meetings_delete ON app.scheduled_meetings FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.scheduled_meetings TO manythreads_app;

ALTER TABLE app.scheduled_meeting_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scheduled_meeting_attendees FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_meeting_attendees_select ON app.scheduled_meeting_attendees FOR SELECT USING (
  (SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
);
CREATE POLICY scheduled_meeting_attendees_insert ON app.scheduled_meeting_attendees FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY scheduled_meeting_attendees_update ON app.scheduled_meeting_attendees FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY scheduled_meeting_attendees_delete ON app.scheduled_meeting_attendees FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.scheduled_meeting_attendees TO manythreads_app;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meetings_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_mark_scheduled_started() OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_schedule(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, uuid[], integer) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_cancel_scheduled(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_scheduled_gate(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.meetings_mark_scheduled_started() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.meetings_schedule(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, uuid[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.meetings_cancel_scheduled(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.meetings_scheduled_gate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meetings_schedule(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, uuid[], integer) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.meetings_cancel_scheduled(uuid) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.meetings_scheduled_gate(uuid) TO manythreads_app, manythreads_system;
