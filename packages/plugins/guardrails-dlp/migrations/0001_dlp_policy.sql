-- guardrails-dlp 0001: the workspace's data-loss policy (PLAN P10-04). Forward-only: never edit once applied.
--
-- app.dlp_detectors holds the choices an admin made for the built-in detectors (what to do when one fires: follow the preset, ignore it, redact, hold for
-- approval, block). A detector with no row keeps the default the shared catalog gives it. app.dlp_custom_rules holds the patterns an admin wrote. Neither
-- table holds text that was matched: the policy says what to look for and what to do, never what was found.
--
-- Reads: every member of the workspace, because the check runs inside whoever's transaction is sending text out (a bot's, a person's, the system's).
-- Writes: workspace owners and admins only (and the system role).

CREATE TABLE app.dlp_detectors (
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  detector      text NOT NULL CHECK (detector ~ '^[a-z0-9-]{1,40}$'),
  action        text NOT NULL CHECK (action IN ('preset', 'allow', 'redact', 'require_approval', 'block')),
  updated_by    uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, detector)
);
CREATE INDEX dlp_detectors_updated_by ON app.dlp_detectors (updated_by) WHERE updated_by IS NOT NULL;
COMMENT ON TABLE app.dlp_detectors IS 'rls: workspace — W: what the data-loss check does when a built-in detector fires (preset, allow, redact, require_approval, block); every workspace member reads it (the check runs in the sender''s transaction), workspace owners and admins write it.';

CREATE TABLE app.dlp_custom_rules (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  pattern       text NOT NULL CHECK (char_length(pattern) BETWEEN 1 AND 190),
  ignore_case   boolean NOT NULL DEFAULT false,
  action        text NOT NULL DEFAULT 'redact' CHECK (action IN ('preset', 'redact', 'require_approval', 'block')),
  enabled       boolean NOT NULL DEFAULT true,
  updated_by    uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE INDEX dlp_custom_rules_updated_by ON app.dlp_custom_rules (updated_by) WHERE updated_by IS NOT NULL;
COMMENT ON TABLE app.dlp_custom_rules IS 'rls: workspace — W: patterns an admin wrote for the data-loss check (the small linear-time subset), each with the action to take; every workspace member reads them, workspace owners and admins write them.';

ALTER TABLE app.dlp_detectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dlp_detectors FORCE ROW LEVEL SECURITY;
CREATE POLICY dlp_detectors_select ON app.dlp_detectors FOR SELECT USING ((SELECT app.is_system()) OR workspace_id = (SELECT app.workspace_id()));
CREATE POLICY dlp_detectors_insert ON app.dlp_detectors FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY dlp_detectors_update ON app.dlp_detectors FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY dlp_detectors_delete ON app.dlp_detectors FOR DELETE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, DELETE ON app.dlp_detectors TO manythreads_app;
GRANT INSERT (workspace_id, detector, action, updated_by, updated_at) ON app.dlp_detectors TO manythreads_app;
GRANT UPDATE (action, updated_by, updated_at) ON app.dlp_detectors TO manythreads_app;

ALTER TABLE app.dlp_custom_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dlp_custom_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY dlp_custom_rules_select ON app.dlp_custom_rules FOR SELECT USING ((SELECT app.is_system()) OR workspace_id = (SELECT app.workspace_id()));
CREATE POLICY dlp_custom_rules_insert ON app.dlp_custom_rules FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY dlp_custom_rules_update ON app.dlp_custom_rules FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY dlp_custom_rules_delete ON app.dlp_custom_rules FOR DELETE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, DELETE ON app.dlp_custom_rules TO manythreads_app;
GRANT INSERT (workspace_id, name, pattern, ignore_case, action, enabled, updated_by) ON app.dlp_custom_rules TO manythreads_app;
GRANT UPDATE (name, pattern, ignore_case, action, enabled, updated_by, updated_at) ON app.dlp_custom_rules TO manythreads_app;
