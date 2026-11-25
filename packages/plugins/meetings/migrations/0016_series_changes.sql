-- P17-05 step 2: a series' rule or time changes, and notes written after the next agenda are added to it (docs/plans/meeting-series.md). Forward-only.
--
-- A RULE CHANGE (every week to every month, 10:00 to 14:00, a new last day) re-makes the meetings still to come from a chosen meeting on: they are deleted and
-- planned again from the new rule. Their numbers go on after the last one kept, so `rule_from` says which number the rule's first meeting (`first_starts_at`)
-- has; the k-th meeting of the series starts at `first_starts_at` plus (k - rule_from) steps, in the series' time zone. An agenda already written for a meeting
-- that is re-made moves to the first new meeting, so what the team wrote in it is kept.
--
--   meeting_series.rule_from             the number of the first meeting of the rule in force (0 until the rule is changed).
--   appointments.agenda_notes_meeting_id the call whose written notes were last copied into this agenda: notes written later than the agenda are added to it
--                                        once, and a box a person took out is not put back.
--   app.meeting_series_start             the start of a meeting of a rule (one formula for the planner and the rule change).
--   app.meeting_series_plan              adds the meetings of a series up to a horizon, as the caller (row level security decides).
--   app.meeting_series_change_rule       the rule change, for whoever may change the series (definer: it deletes and re-numbers rows the platform owns).

ALTER TABLE app.meeting_series ADD COLUMN rule_from integer NOT NULL DEFAULT 0 CHECK (rule_from BETWEEN 0 AND 10000);
COMMENT ON COLUMN app.meeting_series.rule_from IS 'The number (appointments.occurrence) of the first meeting of the rule in force; first_starts_at is that meeting''s start.';

ALTER TABLE app.appointments ADD COLUMN agenda_notes_meeting_id uuid REFERENCES app.meetings (id) ON DELETE SET NULL;
CREATE INDEX appointments_agenda_notes_meeting ON app.appointments (agenda_notes_meeting_id) WHERE agenda_notes_meeting_id IS NOT NULL;

-- The start of the meeting `p_steps` steps after a rule's first one: the local time of the first, plus whole weeks or months, read back in the time zone (10:00
-- stays 10:00 across a change of clocks; a month from the 31st lands on the last day of a shorter month).
CREATE FUNCTION app.meeting_series_start(p_first timestamptz, p_time_zone text, p_frequency text, p_steps integer) RETURNS timestamptz
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT ((p_first AT TIME ZONE p_time_zone)
          + p_steps * CASE p_frequency WHEN 'weekly' THEN interval '7 days' WHEN 'biweekly' THEN interval '14 days' ELSE interval '1 month' END) AT TIME ZONE p_time_zone
$$;

-- Adds the meetings of an active series up to `p_horizon` (always the first of the rule in force), from the one after its last, until its last day. As the caller:
-- the maker while making it (the insert policy), the platform later, or the rule change (a definer). The people are added by the caller.
CREATE FUNCTION app.meeting_series_plan(p_series uuid, p_horizon timestamptz) RETURNS SETOF uuid
  LANGUAGE sql VOLATILE SET search_path = pg_catalog, app, pg_temp
AS $$
  INSERT INTO app.appointments (workspace_id, team_id, space_channel_id, title, agenda, kind, starts_at, ends_at, created_by, created_by_person_id, series_id, occurrence)
  SELECT s.workspace_id, s.team_id, s.space_channel_id, s.title, s.agenda, s.kind, o.starts_at, o.starts_at + make_interval(mins => s.duration_minutes),
         s.created_by, s.created_by_person_id, s.id, o.k
    FROM app.meeting_series s
    CROSS JOIN LATERAL (
      SELECT k, app.meeting_series_start(s.first_starts_at, s.time_zone, s.frequency, k - s.rule_from) AS starts_at
        FROM generate_series(greatest(s.rule_from, coalesce((SELECT max(a.occurrence) + 1 FROM app.appointments a WHERE a.series_id = s.id), 0)), 10000) AS k
       LIMIT 60
    ) o
   WHERE s.id = p_series AND s.status = 'active' AND (o.k = s.rule_from OR o.starts_at <= p_horizon)
     AND (s.until_date IS NULL OR (o.starts_at AT TIME ZONE s.time_zone)::date <= s.until_date)
  ON CONFLICT DO NOTHING
  RETURNING id
$$;
GRANT EXECUTE ON FUNCTION app.meeting_series_start(timestamptz, text, text, integer), app.meeting_series_plan(uuid, timestamptz) TO manythreads_app, manythreads_system;

-- A rule change, by whoever may change the series (its maker, a lead, an admin): the meetings to come from meeting `p_from` on (every one to come when null) are
-- deleted, the series takes the new rule with its first meeting at `p_first`, and the meetings up to `p_horizon` are planned again with the series' people. The
-- first agenda already written among the deleted moves to the first new meeting. Returns the first new meeting. A definer: the rows it deletes and re-numbers
-- are the platform's (the guard triggers), so it checks the caller itself.
CREATE FUNCTION app.meeting_series_change_rule(p_series uuid, p_from integer, p_frequency text, p_first timestamptz, p_minutes integer, p_until date, p_time_zone text,
                                               p_horizon timestamptz) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_series app.meeting_series%ROWTYPE;
  v_people uuid[];
  v_keep_path text;
  v_keep_at timestamptz;
  v_keep_notes uuid;
  v_first uuid;
BEGIN
  IF NOT coalesce(app.meeting_series_can_edit(p_series), false) THEN
    RAISE EXCEPTION 'only its maker, a team lead or an admin can change this series' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_series FROM app.meeting_series s WHERE s.id = p_series AND s.workspace_id = app.workspace_id() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such meeting series' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_series.status <> 'active' THEN
    RAISE EXCEPTION 'this series has stopped' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_first <= now() THEN
    RAISE EXCEPTION 'the new rule starts with a meeting still to come' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_until IS NOT NULL AND p_until < (p_first AT TIME ZONE p_time_zone)::date THEN
    RAISE EXCEPTION 'the series ends before its next meeting' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- the series' people: those of its first meeting to come (they are changed for the meetings to come), else of its latest
  SELECT coalesce(array_agg(i.person_id), '{}') INTO v_people FROM app.appointment_invitees i
   WHERE i.appointment_id = coalesce(
     (SELECT a.id FROM app.appointments a WHERE a.series_id = p_series AND a.status = 'scheduled' AND a.starts_at > now() ORDER BY a.starts_at, a.id LIMIT 1),
     (SELECT a.id FROM app.appointments a WHERE a.series_id = p_series ORDER BY a.starts_at DESC, a.id DESC LIMIT 1));
  SELECT a.agenda_path, a.agenda_written_at, a.agenda_notes_meeting_id INTO v_keep_path, v_keep_at, v_keep_notes FROM app.appointments a
   WHERE a.series_id = p_series AND a.starts_at > now() AND (p_from IS NULL OR a.occurrence >= p_from) AND a.agenda_path IS NOT NULL
   ORDER BY a.starts_at, a.id LIMIT 1;
  DELETE FROM app.appointments a WHERE a.series_id = p_series AND a.starts_at > now() AND (p_from IS NULL OR a.occurrence >= p_from);
  UPDATE app.meeting_series s
     SET frequency = p_frequency, first_starts_at = p_first, duration_minutes = p_minutes, until_date = p_until, time_zone = p_time_zone,
         rule_from = coalesce((SELECT max(a.occurrence) + 1 FROM app.appointments a WHERE a.series_id = p_series), 0), updated_at = now()
   WHERE s.id = p_series;
  PERFORM app.meeting_series_plan(p_series, p_horizon);
  SELECT a.id INTO v_first FROM app.appointments a JOIN app.meeting_series s ON s.id = a.series_id
   WHERE a.series_id = p_series AND a.occurrence = s.rule_from;
  INSERT INTO app.appointment_invitees (appointment_id, person_id)
  SELECT a.id, p FROM app.appointments a JOIN app.meeting_series s ON s.id = a.series_id, unnest(v_people) AS p
   WHERE a.series_id = p_series AND a.occurrence >= s.rule_from
  ON CONFLICT DO NOTHING;
  IF v_first IS NOT NULL AND v_keep_path IS NOT NULL THEN
    UPDATE app.appointments SET agenda_path = v_keep_path, agenda_written_at = v_keep_at, agenda_notes_meeting_id = v_keep_notes
     WHERE id = v_first;
  END IF;
  RETURN v_first;
END
$$;
REVOKE ALL ON FUNCTION app.meeting_series_change_rule(uuid, integer, text, timestamptz, integer, date, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meeting_series_change_rule(uuid, integer, text, timestamptz, integer, date, text, timestamptz) TO manythreads_app;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meeting_series_change_rule(uuid, integer, text, timestamptz, integer, date, text, timestamptz) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

-- The guard of 0013 also keeps the new column the platform's.
CREATE OR REPLACE FUNCTION app.appointments_series_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT app.is_system() AND (NEW.agenda_path IS NOT NULL OR NEW.agenda_written_at IS NOT NULL OR NEW.agenda_notes_meeting_id IS NOT NULL) THEN
      RAISE EXCEPTION 'only the platform writes an agenda' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.appointment_place_ok(NEW.space_channel_id, NEW.series_id, NEW.team_id) THEN
      RAISE EXCEPTION 'this meeting space belongs to another appointment or series' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT app.is_system()
     AND (NEW.series_id, NEW.occurrence, NEW.agenda_path, NEW.agenda_written_at, NEW.agenda_notes_meeting_id, NEW.space_channel_id, NEW.team_id, NEW.workspace_id, NEW.created_by, NEW.created_by_person_id)
         IS DISTINCT FROM (OLD.series_id, OLD.occurrence, OLD.agenda_path, OLD.agenda_written_at, OLD.agenda_notes_meeting_id, OLD.space_channel_id, OLD.team_id, OLD.workspace_id, OLD.created_by, OLD.created_by_person_id) THEN
    RAISE EXCEPTION 'an appointment''s series, space, team and agenda page are the platform''s' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
