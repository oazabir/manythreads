-- P36-04: the team schedule (docs/plans/team-schedule.md). An appointment belongs to a team's common schedule; every member of the team sees it, an invited
-- person of another team sees the ones they are invited to, a guest none. Each has its meeting space (P36-03, a team-less private channel of kind `meeting`
-- whose members are the maker and the invited), opened when it is made: its call, chat, notes and notifications live there. The maker (a member of the team)
-- writes it; its maker, a lead of the team or a workspace admin changes it, its invited and the members of its space.

CREATE TABLE app.appointments (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL,
  team_id          uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  space_channel_id uuid NOT NULL UNIQUE REFERENCES app.channels (id) ON DELETE CASCADE,
  title            text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  agenda           text NOT NULL DEFAULT '' CHECK (char_length(agenda) <= 2000),
  kind             text NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio', 'video')),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_by       uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  -- the maker as a person, for the name others see (an actor row is readable only by its own person)
  created_by_person_id uuid REFERENCES app.people (id) ON DELETE SET NULL,
  reminded_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_span CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '24 hours')
);
CREATE INDEX appointments_team_time ON app.appointments (team_id, starts_at);
CREATE INDEX appointments_due ON app.appointments (starts_at) WHERE status = 'scheduled' AND reminded_at IS NULL;
COMMENT ON TABLE app.appointments IS 'rls: team — C: an appointment of a team''s common schedule (P36-04): read by the members of the team and by the people invited (app.appointment_invitees); made by a member of the team, changed by its maker, a lead of the team or a workspace admin.';

CREATE TABLE app.appointment_invitees (
  appointment_id uuid NOT NULL REFERENCES app.appointments (id) ON DELETE CASCADE,
  person_id      uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  added_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (appointment_id, person_id)
);
CREATE INDEX appointment_invitees_person ON app.appointment_invitees (person_id);
COMMENT ON TABLE app.appointment_invitees IS 'rls: team — C: who is invited to an appointment: read by the person invited and by the members of the appointment''s team; written by whoever may change the appointment.';

-- The team of an appointment, read past row level security (the invitees' policy asks it; reading app.appointments there would loop through its policy).
CREATE FUNCTION app.appointment_team(p_appointment_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$ SELECT a.team_id FROM app.appointments a WHERE a.id = p_appointment_id AND a.workspace_id = app.workspace_id() $$;

-- Whether the caller may change an appointment: its maker, a lead of its team, or a workspace admin.
CREATE FUNCTION app.appointment_can_edit(p_appointment_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT coalesce((SELECT a.created_by = app.actor() OR coalesce(app.lookup_can_team(a.team_id, 'manage'), false)
                     FROM app.appointments a WHERE a.id = p_appointment_id AND a.workspace_id = app.workspace_id()), false)
$$;

-- The members of an appointment's space follow its invited: added people join it, removed ones leave it (the maker stays). Only for whoever may change it.
CREATE FUNCTION app.appointment_sync_space(p_appointment_id uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_space uuid;
  v_maker uuid;
BEGIN
  IF NOT app.appointment_can_edit(p_appointment_id) THEN
    RAISE EXCEPTION 'only its maker, a team lead or an admin can change this appointment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT a.space_channel_id, a.created_by_person_id INTO v_space, v_maker FROM app.appointments a WHERE a.id = p_appointment_id;
  INSERT INTO app.channel_members (channel_id, person_id)
  SELECT v_space, i.person_id FROM app.appointment_invitees i WHERE i.appointment_id = p_appointment_id ON CONFLICT DO NOTHING;
  DELETE FROM app.channel_members m WHERE m.channel_id = v_space AND m.person_id IS DISTINCT FROM v_maker
     AND NOT EXISTS (SELECT 1 FROM app.appointment_invitees i WHERE i.appointment_id = p_appointment_id AND i.person_id = m.person_id);
END
$$;

REVOKE ALL ON FUNCTION app.appointment_team(uuid), app.appointment_can_edit(uuid), app.appointment_sync_space(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.appointment_team(uuid), app.appointment_can_edit(uuid), app.appointment_sync_space(uuid) TO manythreads_app;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.appointment_team(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.appointment_can_edit(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.appointment_sync_space(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

ALTER TABLE app.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_select ON app.appointments FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (
        team_id = ANY ((SELECT app.member_team_ids('read'))::uuid[])
        OR EXISTS (SELECT 1 FROM app.appointment_invitees i WHERE i.appointment_id = id AND i.person_id = (SELECT app.person_id())))));
CREATE POLICY appointments_system ON app.appointments FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY appointments_insert ON app.appointments FOR INSERT WITH CHECK (
  workspace_id = (SELECT app.workspace_id()) AND created_by = (SELECT app.actor()) AND created_by_person_id = (SELECT app.person_id())
  AND team_id = ANY ((SELECT app.member_team_ids('read'))::uuid[]));
CREATE POLICY appointments_update ON app.appointments FOR UPDATE
  USING (workspace_id = (SELECT app.workspace_id()) AND (created_by = (SELECT app.actor()) OR coalesce(app.lookup_can_team(team_id, 'manage'), false)))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()));
GRANT SELECT, INSERT, UPDATE ON app.appointments TO manythreads_app;

ALTER TABLE app.appointment_invitees ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.appointment_invitees FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_invitees_select ON app.appointment_invitees FOR SELECT USING (
  (SELECT app.is_system())
  OR person_id = (SELECT app.person_id())
  OR app.appointment_team(appointment_id) = ANY ((SELECT app.member_team_ids('read'))::uuid[]));
CREATE POLICY appointment_invitees_system ON app.appointment_invitees FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY appointment_invitees_insert ON app.appointment_invitees FOR INSERT WITH CHECK (app.appointment_can_edit(appointment_id));
CREATE POLICY appointment_invitees_delete ON app.appointment_invitees FOR DELETE USING (app.appointment_can_edit(appointment_id));
GRANT SELECT, INSERT, DELETE ON app.appointment_invitees TO manythreads_app;
