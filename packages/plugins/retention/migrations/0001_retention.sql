-- retention 0001: how long a workspace keeps its run logs, and the permission to delete them (PLAN P5-14; SPEC §15). Forward-only: never edit
-- once applied.
--
--  * retention_settings: one row per workspace that changed the defaults (90 days of run logs, 365 of memory log bookkeeping), and the summary
--    of its newest sweep. Workspace admins read and change the windows (within the CHECK bounds, which the API also states); only the system role
--    writes `last_sweep`.
--  * DELETE policies on app.bot_runs and app.run_source_log for the system role. The bots plugin gave them none, so no role could delete a run
--    (a bot's removal cascades through the foreign key, which is not subject to row level security). Retention is the first thing that deletes
--    runs, and it does it as the system role in batches; nothing else gains a path (the app role has no DELETE privilege on either table).
--  * an index for the sweep: a workspace's ended runs in time order.
--
-- What retention deletes, and what it never does (docs/plugins/retention.md): run logs (bot_runs, with run_source_log and mcp_run_tokens that hang
-- off them) older than the window; memory feed bookkeeping (superseded lines and attempt notes of memory_retain_log, memos of removed bots). It
-- never touches events (the audit log), approvals and their decisions, the spend ledger, withheld lines, or the newest state of any source.
--
-- Ordering: the manifest's `dependsOn` puts this after bots (bot_runs, run_source_log), memory (its functions) and approvals.

CREATE TABLE app.retention_settings (
  workspace_id    uuid PRIMARY KEY REFERENCES app.workspaces (id) ON DELETE CASCADE,
  run_log_days    integer NOT NULL DEFAULT 90 CHECK (run_log_days BETWEEN 30 AND 3650),
  memory_log_days integer NOT NULL DEFAULT 365 CHECK (memory_log_days BETWEEN 90 AND 3650),
  last_sweep      jsonb,
  updated_by      uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retention_settings_updated_by ON app.retention_settings (updated_by) WHERE updated_by IS NOT NULL;
COMMENT ON TABLE app.retention_settings IS 'rls: workspace — W: workspace admins set how many days of run logs and of memory feed bookkeeping the workspace keeps (bounded by CHECK); only the system role writes the summary of the last sweep.';

ALTER TABLE app.retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.retention_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_settings_admin ON app.retention_settings FOR ALL
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
-- An admin changes the windows through the route; the summary of a sweep is the system's (no column privilege for the app role).
GRANT SELECT ON app.retention_settings TO manythreads_app;
GRANT INSERT (workspace_id, run_log_days, memory_log_days, updated_by, updated_at) ON app.retention_settings TO manythreads_app;
GRANT UPDATE (run_log_days, memory_log_days, updated_by, updated_at) ON app.retention_settings TO manythreads_app;

-- the permission to delete run logs (system role only: the request role has no DELETE privilege on either table)
CREATE POLICY bot_runs_retention_delete ON app.bot_runs FOR DELETE USING ((SELECT app.is_system()));
CREATE POLICY run_source_log_retention_delete ON app.run_source_log FOR DELETE USING ((SELECT app.is_system()));

-- the sweep's range scan: one workspace's ended runs in time order (the primary key breaks ties for the cursor)
CREATE INDEX bot_runs_retention ON app.bot_runs (workspace_id, ended_at, id) WHERE ended_at IS NOT NULL;
