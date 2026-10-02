-- teams plugin 0003 (P3-00): team_role_tags read policy in the hoisted form of kernel 0011 (readable teams computed once per
-- statement instead of app.is_team_member() per row). Same visibility: members of the team, workspace admins of every team.
-- Forward-only: never edit once applied.
DROP POLICY team_role_tags_select ON app.team_role_tags;
CREATE POLICY team_role_tags_select ON app.team_role_tags FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
