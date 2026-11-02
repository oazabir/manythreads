-- runtime-hermes 0004: runners replace team-made connections (PLAN.md Phase 19, P19-02). Forward-only: never edit once applied.
--
-- Two changes.
--
--  1. runner_name: a connection that a workspace admin adopted into a runner (docs/plugins/bot-runners.md) keeps its row, so that a BOT.md saying
--     `placement.gateway.connection: host` still finds it, but from that day the run is resolved through the runner of that name (its address, key, on/off
--     state and team list), never through this row. The row's own address and key are no longer read. No foreign key: the runner table belongs to
--     another plugin; the name is unique per workspace and never changes.
--  2. A team lead can no longer write connections. Making, changing and removing one is a workspace admin's job (as a runner); the platform still writes
--     the reserved `managed` row for a team's own pod. The policies below drop the lead's right to insert, update and delete (the system role and a
--     workspace admin keep it). Leads and members of the team still read the rows through the list route, which hides the address from them.

ALTER TABLE app.hermes_connections
  ADD COLUMN runner_name text CHECK (runner_name IS NULL OR runner_name ~ '^[a-z0-9][a-z0-9._-]{0,62}$');
CREATE INDEX hermes_connections_runner ON app.hermes_connections (workspace_id, runner_name) WHERE runner_name IS NOT NULL;
COMMENT ON COLUMN app.hermes_connections.runner_name IS 'The bot runner this connection was adopted into (bot-runners, by name within the workspace), or null while it is still the team''s own.';

DROP POLICY hermes_connections_insert ON app.hermes_connections;
DROP POLICY hermes_connections_update ON app.hermes_connections;
DROP POLICY hermes_connections_delete ON app.hermes_connections;
CREATE POLICY hermes_connections_insert ON app.hermes_connections FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_workspace_admin()))
);
CREATE POLICY hermes_connections_update ON app.hermes_connections FOR UPDATE USING (
  (SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_workspace_admin()))
) WITH CHECK (
  (SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_workspace_admin()))
);
CREATE POLICY hermes_connections_delete ON app.hermes_connections FOR DELETE USING (
  (SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_workspace_admin()))
);
COMMENT ON TABLE app.hermes_connections IS 'rls: team — T: connections of the teams the caller can read (app.readable_team_ids); written by workspace admins and the system only (a team lead no longer makes connections: runners, P19-02); the key is secret_id, never a column.';
