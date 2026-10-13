-- memory-git-mirror 0001: the work list of the OKF bundle's mirror and the record of which teams have their bundle root (PLAN P5-14; SPEC §12.1).
-- Forward-only: never edit once applied.
--
--  * memory_mirror_pending: the mirror's work list, one row per (team, concept path) that a commit under `memory/` touched. A commit only marks
--    "this concept changed" (the outbox consumer's transaction is shared with every other plugin's handler, so it never reads text and never
--    calls the engine); the drain job reads the concept as it is NOW, decides, and talks to the engine. A burst of edits is one retain, a late or
--    repeated event cannot bring back a deleted concept, and the engine being down never blocks the outbox. System only.
--  * memory_mirror_teams: the teams whose bundle root (`memory/index.md`, `memory/log.md`) the mirror has seen to. A row is the whole of "first
--    use": written in the transaction that wrote the files (or found them), so the files are written once however many events arrive.
--
-- What the mirror retains goes through `memory_retain_log` (the `memory` plugin's table, `source_kind = 'concept'`, source id `<team id>/<path>`),
-- keyed by the same per-workspace digest key as the feed (`memory_workspace_keys`).

CREATE TABLE app.memory_mirror_pending (
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  path           text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 1100),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  -- debounce, back-off and "the run has not closed yet" all push this out
  not_before     timestamptz NOT NULL DEFAULT now(),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  deferred_since timestamptz,
  last_error     text NOT NULL DEFAULT '' CHECK (char_length(last_error) <= 300),
  PRIMARY KEY (team_id, path)
);
CREATE INDEX memory_mirror_pending_due ON app.memory_mirror_pending (not_before, requested_at);
CREATE INDEX memory_mirror_pending_workspace ON app.memory_mirror_pending (workspace_id);
COMMENT ON TABLE app.memory_mirror_pending IS 'rls: system — S: the git mirror''s work list (concepts of memory/ that changed and have not been reconciled with the bank yet); no privilege for manythreads_app.';

CREATE TABLE app.memory_mirror_teams (
  team_id        uuid PRIMARY KEY REFERENCES app.teams (id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  initialized_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_mirror_teams_workspace ON app.memory_mirror_teams (workspace_id);
COMMENT ON TABLE app.memory_mirror_teams IS 'rls: system — S: the teams whose memory bundle root (index.md, log.md) the git mirror has written or found; no privilege for manythreads_app.';

ALTER TABLE app.memory_mirror_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_mirror_pending FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_mirror_pending_system ON app.memory_mirror_pending FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

ALTER TABLE app.memory_mirror_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_mirror_teams FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_mirror_teams_system ON app.memory_mirror_teams FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: the work list is the platform's
