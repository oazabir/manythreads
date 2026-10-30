-- onboarding 0001: the few facts of the first admin's setup checklist that nothing else records (PLAN P10-01). Forward-only: never edit once applied.
--
-- Whether a model answers, whether a team exists and whether Brain is on it are facts the owning plugins already hold, and the checklist reads them
-- from there on every look, so nothing here can drift from them or be ticked by a click. What is kept here is only what a person decided or did:
--
--  * onboarding_state: one row per workspace. `launched_*` is set when the first goal was sent to Brain from the wizard (only ids: the words are a
--    message like any other and live with the conversation). `dismissed_*` is set when an admin put the checklist away, and the database refuses a
--    dismissal that has no launch before it.
--  * onboarding_marks: an optional step set aside on purpose (code, infrastructure, servers) and the "sign-in is password only" confirmation. A mark
--    only ever records a decision; a step that is a fact (models, teams, bots) has no mark, so it cannot be skipped around.
--
-- `*_by` and the team/channel ids carry no foreign key on purpose: they are pointers owned by other plugins (people and actors, teams, channels)
-- and the record should survive their deletion. Both tables belong to workspace owners and admins only.

CREATE TABLE app.onboarding_state (
  workspace_id       uuid        PRIMARY KEY REFERENCES app.workspaces (id) ON DELETE CASCADE,
  launched_at        timestamptz,
  launched_by        uuid,
  launch_team_id     uuid,
  launch_channel_id  uuid,
  dismissed_at       timestamptz,
  dismissed_by       uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- a launch is all of its fields or none of them
  CONSTRAINT onboarding_state_launch_shape CHECK (
    (launched_at IS NULL AND launch_team_id IS NULL AND launch_channel_id IS NULL)
    OR (launched_at IS NOT NULL AND launch_team_id IS NOT NULL AND launch_channel_id IS NOT NULL)
  ),
  -- the checklist can be put away only after the first goal was sent
  CONSTRAINT onboarding_state_dismiss_after_launch CHECK (dismissed_at IS NULL OR launched_at IS NOT NULL)
);
COMMENT ON TABLE app.onboarding_state IS 'rls: workspace — W: workspace owners and admins read and write the one row per workspace that says whether the first goal was sent to Brain and whether the setup checklist was put away.';

CREATE TABLE app.onboarding_marks (
  workspace_id uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  step         text        NOT NULL CHECK (step IN ('signin', 'code', 'infrastructure', 'servers')),
  kind         text        NOT NULL CHECK (kind IN ('skipped', 'acknowledged')),
  marked_by    uuid,
  marked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, step),
  -- "password only" is a confirmation of the sign-in step; the other three can only be set aside
  CONSTRAINT onboarding_marks_kind_by_step CHECK ((step = 'signin' AND kind = 'acknowledged') OR (step <> 'signin' AND kind = 'skipped'))
);
COMMENT ON TABLE app.onboarding_marks IS 'rls: workspace — W: workspace owners and admins read and write the optional setup steps they set aside and the password-only sign-in confirmation.';

ALTER TABLE app.onboarding_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.onboarding_state FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_state_admin ON app.onboarding_state FOR ALL
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.onboarding_state TO manythreads_app;

ALTER TABLE app.onboarding_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.onboarding_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_marks_admin ON app.onboarding_marks FOR ALL
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.onboarding_marks TO manythreads_app;
