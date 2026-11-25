-- P17-05: meeting series (docs/plans/meeting-series.md). Forward-only: never edit once applied.
--
-- A SERIES is a meeting of a team's schedule that repeats: every week, every two weeks or every month, from its first meeting, in its own time zone (10:00 stays
-- 10:00 across a change of clocks), until an optional last day. Each meeting of it is an appointment (0010) with `series_id` and its number `occurrence`; they
-- share ONE meeting space (P36-03), so the series has one chat and one Files folder. Its folder in the team repo, `meetings/series/<slug>/`, holds an agenda page per
-- meeting, written by the platform (`agenda_path`, `agenda_written_at`) and edited live by the team.
--
--   meeting_series   read by the members of its team and the people of its space; made by a member of the team for a space they opened; changed (title,
--                    agenda line, stopped) by its maker, a lead of the team or a workspace admin. Everything else is the platform's (the guard trigger).
--   appointments     gains the series columns. A space serves one appointment, or the meetings of one series. A person never sets or moves the series columns or
--                    the agenda path (the guard trigger): the platform's job writes a file at that path.

CREATE TABLE app.meeting_series (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id         uuid NOT NULL,
  team_id              uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  space_channel_id     uuid NOT NULL UNIQUE REFERENCES app.channels (id) ON DELETE CASCADE,
  -- the folder name under meetings/series/ (lower-case words joined by single hyphens; isSeriesSlug in packages/shared)
  slug                 text NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 48 AND slug ~ '^[a-z0-9-]+$' AND slug !~ '(^-|-$|--)'),
  title                text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  agenda               text NOT NULL DEFAULT '' CHECK (char_length(agenda) <= 2000),
  kind                 text NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio', 'video')),
  frequency            text NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly')),
  time_zone            text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  first_starts_at      timestamptz NOT NULL,
  duration_minutes     integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  until_date           date,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  created_by           uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_by_person_id uuid REFERENCES app.people (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  stopped_at           timestamptz,
  UNIQUE (team_id, slug),
  CONSTRAINT meeting_series_stopped CHECK ((status = 'stopped') = (stopped_at IS NOT NULL))
);
CREATE INDEX meeting_series_active ON app.meeting_series (workspace_id) WHERE status = 'active';
CREATE INDEX meeting_series_created_by ON app.meeting_series (created_by);
CREATE INDEX meeting_series_created_by_person ON app.meeting_series (created_by_person_id);
COMMENT ON TABLE app.meeting_series IS 'rls: team — C: a meeting series of a team''s schedule (P17-05): read by the members of its team and the people of its meeting space; made by a member of the team for a space they opened; its title, agenda line and status changed by its maker, a lead of the team or a workspace admin; the rest only by the platform.';

ALTER TABLE app.appointments
  ADD COLUMN series_id         uuid REFERENCES app.meeting_series (id) ON DELETE CASCADE,
  ADD COLUMN occurrence        integer CHECK (occurrence IS NULL OR occurrence BETWEEN 0 AND 10000),
  ADD COLUMN agenda_path       text CHECK (agenda_path IS NULL OR (char_length(agenda_path) <= 200 AND agenda_path LIKE 'meetings/series/%')),
  ADD COLUMN agenda_written_at timestamptz,
  ADD CONSTRAINT appointments_series_shape CHECK ((series_id IS NULL) = (occurrence IS NULL) AND (agenda_path IS NULL OR series_id IS NOT NULL) AND ((agenda_path IS NULL) = (agenda_written_at IS NULL)));
CREATE UNIQUE INDEX appointments_series_occurrence ON app.appointments (series_id, occurrence) WHERE series_id IS NOT NULL;
CREATE UNIQUE INDEX appointments_agenda_path ON app.appointments (team_id, agenda_path) WHERE agenda_path IS NOT NULL;
-- the meetings of a series share one space: the space stays one appointment's only for an appointment on its own
ALTER TABLE app.appointments DROP CONSTRAINT appointments_space_channel_id_key;
CREATE UNIQUE INDEX appointments_space_single ON app.appointments (space_channel_id) WHERE series_id IS NULL;
CREATE INDEX appointments_space ON app.appointments (space_channel_id);

-- Whether the caller may change a series: its maker, a lead of its team, or a workspace admin.
CREATE FUNCTION app.meeting_series_can_edit(p_series_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT coalesce((SELECT s.created_by = app.actor() OR coalesce(app.lookup_can_team(s.team_id, 'manage'), false)
                     FROM app.meeting_series s WHERE s.id = p_series_id AND s.workspace_id = app.workspace_id()), false)
$$;

-- Whether an appointment may use a space: an appointment on its own takes a space no series uses (the partial unique index keeps it to one); a meeting of a series
-- takes that series' own space, of the same team, while the series is active, and a space no other appointment uses. Read past row level security.
CREATE FUNCTION app.appointment_place_ok(p_space uuid, p_series uuid, p_team uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT CASE WHEN p_series IS NULL
    THEN NOT EXISTS (SELECT 1 FROM app.appointments x WHERE x.space_channel_id = p_space AND x.series_id IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM app.meeting_series s WHERE s.space_channel_id = p_space)
    ELSE EXISTS (SELECT 1 FROM app.meeting_series s WHERE s.id = p_series AND s.space_channel_id = p_space AND s.team_id = p_team AND s.status = 'active')
         AND NOT EXISTS (SELECT 1 FROM app.appointments x WHERE x.space_channel_id = p_space AND x.series_id IS DISTINCT FROM p_series)
  END
$$;

-- Whether a new series may take a space: one the caller opened for that team (app.meetings_open_space), that no appointment uses yet.
CREATE FUNCTION app.meeting_series_space_ok(p_space uuid, p_team uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app.meeting_spaces sp WHERE sp.channel_id = p_space AND sp.team_id = p_team AND sp.created_by = app.actor())
     AND NOT EXISTS (SELECT 1 FROM app.appointments x WHERE x.space_channel_id = p_space)
$$;

REVOKE ALL ON FUNCTION app.meeting_series_can_edit(uuid), app.appointment_place_ok(uuid, uuid, uuid), app.meeting_series_space_ok(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meeting_series_can_edit(uuid), app.appointment_place_ok(uuid, uuid, uuid), app.meeting_series_space_ok(uuid, uuid) TO manythreads_app, manythreads_system;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meeting_series_can_edit(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.appointment_place_ok(uuid, uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.meeting_series_space_ok(uuid, uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

-- The guards run as the caller (not definers), so app.is_system() is the real role.
CREATE FUNCTION app.meeting_series_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT app.is_system() AND NOT app.meeting_series_space_ok(NEW.space_channel_id, NEW.team_id) THEN
      RAISE EXCEPTION 'a series takes a meeting space you opened for its team' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'a series starts active' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT app.is_system()
     AND (to_jsonb(NEW) - ARRAY['title', 'agenda', 'status', 'stopped_at', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['title', 'agenda', 'status', 'stopped_at', 'updated_at']) THEN
    RAISE EXCEPTION 'a series changes its title, its agenda line or stops; the rest is the platform''s' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'stopped' AND NEW.status <> 'stopped' THEN
    RAISE EXCEPTION 'this series has stopped' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER meeting_series_guard BEFORE INSERT OR UPDATE ON app.meeting_series FOR EACH ROW EXECUTE FUNCTION app.meeting_series_guard();

CREATE FUNCTION app.appointments_series_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT app.is_system() AND (NEW.agenda_path IS NOT NULL OR NEW.agenda_written_at IS NOT NULL) THEN
      RAISE EXCEPTION 'only the platform writes an agenda' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.appointment_place_ok(NEW.space_channel_id, NEW.series_id, NEW.team_id) THEN
      RAISE EXCEPTION 'this meeting space belongs to another appointment or series' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT app.is_system()
     AND (NEW.series_id, NEW.occurrence, NEW.agenda_path, NEW.agenda_written_at, NEW.space_channel_id, NEW.team_id, NEW.workspace_id, NEW.created_by, NEW.created_by_person_id)
         IS DISTINCT FROM (OLD.series_id, OLD.occurrence, OLD.agenda_path, OLD.agenda_written_at, OLD.space_channel_id, OLD.team_id, OLD.workspace_id, OLD.created_by, OLD.created_by_person_id) THEN
    RAISE EXCEPTION 'an appointment''s series, space, team and agenda page are the platform''s' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER appointments_series_guard BEFORE INSERT OR UPDATE ON app.appointments FOR EACH ROW EXECUTE FUNCTION app.appointments_series_guard();

-- A meeting of a series is added by whoever may change the series (its maker making it, or later the platform).
DROP POLICY appointments_insert ON app.appointments;
CREATE POLICY appointments_insert ON app.appointments FOR INSERT WITH CHECK (
  workspace_id = (SELECT app.workspace_id()) AND created_by = (SELECT app.actor()) AND created_by_person_id = (SELECT app.person_id())
  AND team_id = ANY ((SELECT app.member_team_ids('read'))::uuid[])
  AND (series_id IS NULL OR app.meeting_series_can_edit(series_id)));

ALTER TABLE app.meeting_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_series FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_series_select ON app.meeting_series FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (
        team_id = ANY ((SELECT app.member_team_ids('read'))::uuid[])
        OR space_channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]))));
CREATE POLICY meeting_series_system ON app.meeting_series FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_series_insert ON app.meeting_series FOR INSERT WITH CHECK (
  workspace_id = (SELECT app.workspace_id()) AND created_by = (SELECT app.actor()) AND created_by_person_id = (SELECT app.person_id())
  AND team_id = ANY ((SELECT app.member_team_ids('read'))::uuid[]));
CREATE POLICY meeting_series_update ON app.meeting_series FOR UPDATE
  USING (workspace_id = (SELECT app.workspace_id()) AND (created_by = (SELECT app.actor()) OR coalesce(app.lookup_can_team(team_id, 'manage'), false)))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()));
GRANT SELECT, INSERT, UPDATE ON app.meeting_series TO manythreads_app;
