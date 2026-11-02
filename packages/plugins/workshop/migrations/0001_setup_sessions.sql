-- workshop 0001: "Add a bot" setup sessions (PLAN P7-02 to P7-04). Forward-only: never edit once applied.
--
-- A setup session is one person's conversation with the setup helper: the brief they wrote, what the helper found in the team (the inventory it was shown,
-- names only), the requirements it listed and how the platform graded each, the questions it asked and the answers, and the proposals it ended in. It is
-- the person's own: nobody else reads it, not a lead and not an admin, because the brief may say anything. The helper's own words so far (`history`) are
-- kept so a later round continues the same conversation; the API never returns them.
--
-- The person reads, starts and answers their own sessions. The helper's job writes through the system role (it works while no request is open).
CREATE TABLE app.setup_sessions (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'working' CHECK (status IN ('working', 'asking', 'proposed', 'failed', 'cancelled')),
  brief         text NOT NULL CHECK (char_length(brief) BETWEEN 8 AND 4000),
  name          text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 80),
  requirements  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(requirements) = 'array'),
  questions     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions) = 'array'),
  answers       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(answers) = 'array'),
  inventory     jsonb CHECK (inventory IS NULL OR jsonb_typeof(inventory) = 'object'),
  proposals     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(proposals) = 'array'),
  limits        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(limits) = 'array'),
  history       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array' AND pg_column_size(history) <= 400000),
  message       text CHECK (message IS NULL OR char_length(message) <= 2000),
  rounds        integer NOT NULL DEFAULT 0 CHECK (rounds >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX setup_sessions_workspace ON app.setup_sessions (workspace_id);
CREATE INDEX setup_sessions_team ON app.setup_sessions (team_id);
CREATE INDEX setup_sessions_owner ON app.setup_sessions (owner_id, created_at DESC);
COMMENT ON TABLE app.setup_sessions IS 'rls: person — P: one person''s "Add a bot" conversation with the setup helper (brief, inventory shown, graded requirements, questions, answers, the proposals made); nobody else reads or changes it, not even an admin; the helper''s job writes as the system role.';

ALTER TABLE app.setup_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.setup_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY setup_sessions_select ON app.setup_sessions FOR SELECT
  USING ((SELECT app.is_system()) OR owner_id = (SELECT app.actor()));
CREATE POLICY setup_sessions_insert ON app.setup_sessions FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND owner_id = (SELECT app.actor())));
CREATE POLICY setup_sessions_update ON app.setup_sessions FOR UPDATE
  USING ((SELECT app.is_system()) OR owner_id = (SELECT app.actor()))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND owner_id = (SELECT app.actor())));
CREATE POLICY setup_sessions_delete ON app.setup_sessions FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE ON app.setup_sessions TO manythreads_app;
