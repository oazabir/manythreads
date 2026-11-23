-- projects 0007: an issue of a project's repository given to the team's bots (P35-04, owner 2026-11-20). Forward-only: never edit once applied.
--
-- An open GitHub issue labelled `manythreads` becomes a thread in the project's channel (the platform posts the issue's title, text and link) and the
-- team's Engineer is woken there, as for a person's request. This table remembers which issue became which thread, so an issue is taken once, and what
-- was said back on the issue (the pull request the chain opened, its merge), so each is said once. The server's sync job writes it (system); the team reads it.

CREATE TABLE app.project_issues (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES app.projects (id) ON DELETE CASCADE,
  number          integer NOT NULL CHECK (number > 0),
  url             text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 300),
  title           text NOT NULL CHECK (char_length(title) <= 300),
  root_message_id uuid REFERENCES app.messages (id) ON DELETE SET NULL,
  -- what was said back on the issue: the pull request number commented on, and whether its merge was
  said_pr         integer,
  said_merged     boolean NOT NULL DEFAULT false,
  state           text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
CREATE INDEX project_issues_open ON app.project_issues (project_id) WHERE state = 'open';
CREATE INDEX project_issues_root ON app.project_issues (root_message_id) WHERE root_message_id IS NOT NULL;
COMMENT ON TABLE app.project_issues IS 'rls: team — S: the GitHub issues given to the team''s bots (P35-04); the server''s issue sync writes them, the team reads.';

ALTER TABLE app.project_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY project_issues_select ON app.project_issues FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY project_issues_system ON app.project_issues FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.project_issues TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.project_issues TO manythreads_system;
