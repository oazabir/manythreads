-- guardrails-egress 0002: a team's list can only be written under the workspace the team belongs to (PLAN P10-04). Forward-only: never edit once applied.
--
-- 0001 checked that the row names the writer's workspace, but not that the team does: an admin could have filed a row for another workspace's team under
-- their own workspace id. The row would be harmless to read for the other team (the read policy follows the team), but it would still be a write across a
-- boundary, and a foreign key alone does not say whose team it is.

DROP POLICY team_egress_insert ON app.team_egress;
DROP POLICY team_egress_update ON app.team_egress;
CREATE POLICY team_egress_insert ON app.team_egress FOR INSERT
  WITH CHECK (
    (SELECT app.is_system())
    OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')
        AND EXISTS (SELECT 1 FROM app.teams t WHERE t.id = team_id AND t.workspace_id = team_egress.workspace_id)));
CREATE POLICY team_egress_update ON app.team_egress FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK (
    (SELECT app.is_system())
    OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')
        AND EXISTS (SELECT 1 FROM app.teams t WHERE t.id = team_id AND t.workspace_id = team_egress.workspace_id)));
