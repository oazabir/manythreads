-- test-kernel: a team-scoped stub resource that proves team-level denial through app.can() (PLAN.md P2-07).
-- Test-only: exists only where the test plugins are loaded (MAJLIS_TEST_PLUGINS=1 or the test sources).
CREATE TABLE app.stub_resources (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stub_resources_team ON app.stub_resources (team_id);
CREATE INDEX stub_resources_workspace ON app.stub_resources (workspace_id);
COMMENT ON TABLE app.stub_resources IS 'rls: team — test-only team-scoped resource; read needs app.can(read), writes need post on the team.';

INSERT INTO app.resource_kinds (resource_type, table_name, team_column) VALUES ('stub_resource', 'stub_resources', 'team_id');

ALTER TABLE app.stub_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stub_resources FORCE ROW LEVEL SECURITY;
-- A policy cannot look its own new row up by id (the check runs before the row exists, so INSERT ... RETURNING would
-- fail): rows are judged by their team_id with app.can_in_team first, and by app.can(id) for ACL grants after.
CREATE POLICY stub_resources_select ON app.stub_resources FOR SELECT
  USING (app.is_system() OR app.can_in_team(team_id, 'read') OR app.can('stub_resource', id, 'read'));
CREATE POLICY stub_resources_insert ON app.stub_resources FOR INSERT
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.can_in_team(team_id, 'post')));
CREATE POLICY stub_resources_update ON app.stub_resources FOR UPDATE
  USING (app.is_system() OR app.can_in_team(team_id, 'post') OR app.can('stub_resource', id, 'post'))
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.can_in_team(team_id, 'post')));
CREATE POLICY stub_resources_delete ON app.stub_resources FOR DELETE
  USING (app.is_system() OR app.can_in_team(team_id, 'manage') OR app.can('stub_resource', id, 'manage'));

GRANT SELECT, INSERT, UPDATE, DELETE ON app.stub_resources TO majlis_app;

-- 0001's table, tagged with the RLS kind the harness requires.
COMMENT ON TABLE app.test_kernel_deliveries IS 'rls: workspace — W: deliveries of the test event, per workspace.';
