-- test-kernel: records every kernel.test.pinged delivery so API tests can count them. Test-only plugin
-- (loaded only when MAJLIS_TEST_PLUGINS=1). Workspace-scoped (W) with RLS.
CREATE TABLE app.test_kernel_deliveries (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  event        jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX test_kernel_deliveries_workspace ON app.test_kernel_deliveries (workspace_id);

ALTER TABLE app.test_kernel_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.test_kernel_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY test_kernel_deliveries_workspace ON app.test_kernel_deliveries
  USING (workspace_id = app.workspace_id() OR app.is_system())
  WITH CHECK (workspace_id = app.workspace_id() OR app.is_system());

GRANT SELECT, INSERT ON app.test_kernel_deliveries TO majlis_app;
