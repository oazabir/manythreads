-- presence 0001: custom status, time zone, working hours, out of office and Do not disturb (PLAN.md P14-01). Forward-only: never edit once applied.
--
-- The heartbeat that says "online" or "away" is `app.presence` (channels 0003, UNLOGGED); this plugin owns its routes and shows it with the
-- rest. What a person says about themself is durable, so it lives in two ordinary tables:
--
--   person_status  what everyone may read beside a name: custom status, time zone, working hours, out of office.
--   dnd_settings   Do not disturb. Private: only the person (and the system, which holds and releases notifications by it) reads it.
--
-- A status past `status_clears_at` is not shown: readers filter it, so nothing has to delete it at the right second.

CREATE TABLE app.person_status (
  person_id        uuid PRIMARY KEY REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  status_emoji     text CHECK (status_emoji IS NULL OR length(status_emoji) BETWEEN 1 AND 16),
  status_text      text NOT NULL DEFAULT '' CHECK (length(status_text) <= 100),
  status_clears_at timestamptz,
  time_zone        text CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 64),
  working_hours    jsonb CHECK (working_hours IS NULL OR jsonb_typeof(working_hours) = 'object'),
  ooo_active       boolean NOT NULL DEFAULT false,
  ooo_returns_on   date,
  ooo_delegate_id  uuid REFERENCES app.people (id) ON DELETE SET NULL,
  ooo_message      text NOT NULL DEFAULT '' CHECK (length(ooo_message) <= 200),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_status_workspace ON app.person_status (workspace_id);
CREATE INDEX person_status_ooo_delegate ON app.person_status (ooo_delegate_id) WHERE ooo_delegate_id IS NOT NULL;
COMMENT ON TABLE app.person_status IS 'rls: workspace — WR: a status, time zone, working hours and out-of-office note per person; members read everyone of the workspace, a guest only themself; a person writes only their own row.';

CREATE TABLE app.dnd_settings (
  person_id    uuid PRIMARY KEY REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT false,
  paused_until timestamptz,
  schedule     jsonb NOT NULL DEFAULT '{"enabled": false, "windows": []}' CHECK (jsonb_typeof(schedule) = 'object'),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dnd_settings_workspace ON app.dnd_settings (workspace_id);
COMMENT ON TABLE app.dnd_settings IS 'rls: person — P: Do not disturb settings; a person reads and writes only their own, the system (notifications) reads them to hold and release.';

ALTER TABLE app.person_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.person_status FORCE ROW LEVEL SECURITY;
CREATE POLICY person_status_select ON app.person_status FOR SELECT USING (
  (SELECT app.is_system())
  OR person_id = (SELECT app.person_id())
  OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin', 'member')));
CREATE POLICY person_status_insert ON app.person_status FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY person_status_update ON app.person_status FOR UPDATE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system()) OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY person_status_delete ON app.person_status FOR DELETE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));

ALTER TABLE app.dnd_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dnd_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY dnd_settings_select ON app.dnd_settings FOR SELECT
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY dnd_settings_insert ON app.dnd_settings FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY dnd_settings_update ON app.dnd_settings FOR UPDATE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system()) OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY dnd_settings_delete ON app.dnd_settings FOR DELETE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON app.person_status TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.dnd_settings TO manythreads_app;

-- Is this an active person of the caller's workspace? `people` shows a caller only their own row, so the out-of-office delegate is checked by
-- a definer function (owned by manythreads_system, like channels' lookups). It answers a yes or no and nothing else about the person.
CREATE FUNCTION app.presence_person_in_workspace(p_person_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app.people p WHERE p.id = p_person_id AND p.status = 'active' AND p.workspace_id = app.workspace_id());
$$;
REVOKE ALL ON FUNCTION app.presence_person_in_workspace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.presence_person_in_workspace(uuid) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.presence_person_in_workspace(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
