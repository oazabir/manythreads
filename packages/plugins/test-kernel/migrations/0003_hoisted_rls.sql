-- test-kernel 0003 (P3-00): stub_resources read policy in the hoisted form of kernel 0011. It is the benchmark table for
-- the idiom (300,000 rows, unscoped count in under 2 s; it took 77 s with per-row app.can_in_team / app.can).
-- Same visibility as before: members and leads of the team, workspace admins, and holders of an acl_entries grant.
-- Forward-only: never edit once applied.
DROP POLICY stub_resources_select ON app.stub_resources;
CREATE POLICY stub_resources_select ON app.stub_resources FOR SELECT USING (
  (SELECT app.is_system())
  OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
  OR (workspace_id = (SELECT app.workspace_id()) AND id = ANY ((SELECT app.acl_grant_ids('stub_resource', 'read'))::uuid[]))
);
