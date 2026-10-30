-- guardrails-egress 0001: each team's list of hosts its bots may reach, and an optional proxy (PLAN P10-04). Forward-only: never edit once applied.
--
-- One row per team that an admin has configured. `enforce` is the switch: on, the team's bots may reach only the hosts listed here (plus the workspace's own
-- list); off, the list is kept but adds no restriction. `proxy_url` is where the team's outgoing requests are meant to be sent through; it is stored here
-- and read by whatever sends the request (no address with a user name or password is accepted, so no secret lives in this table).
--
-- Reads: workspace owners and admins, and members of the team (the hook runs in the sender's transaction). Writes: workspace owners and admins.

CREATE TABLE app.team_egress (
  team_id       uuid PRIMARY KEY REFERENCES app.teams (id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  enforce       boolean NOT NULL DEFAULT false,
  hosts         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(hosts) <= 200),
  proxy_url     text CHECK (proxy_url IS NULL OR (char_length(proxy_url) <= 300 AND proxy_url ~ '^https?://[^@/\s]+/?$')),
  updated_by    uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_egress_workspace ON app.team_egress (workspace_id);
CREATE INDEX team_egress_updated_by ON app.team_egress (updated_by) WHERE updated_by IS NOT NULL;
COMMENT ON TABLE app.team_egress IS 'rls: team — W: the hosts a team''s bots may reach and the team''s proxy address; readable by workspace owners and admins and by members of the team, written by workspace owners and admins only.';

ALTER TABLE app.team_egress ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_egress FORCE ROW LEVEL SECURITY;
CREATE POLICY team_egress_select ON app.team_egress FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin'))
  OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY team_egress_insert ON app.team_egress FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY team_egress_update ON app.team_egress FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT ON app.team_egress TO manythreads_app;
GRANT INSERT (team_id, workspace_id, enforce, hosts, proxy_url, updated_by, updated_at) ON app.team_egress TO manythreads_app;
GRANT UPDATE (enforce, hosts, proxy_url, updated_by, updated_at) ON app.team_egress TO manythreads_app;
