-- projects 0003: a project may hold a GitHub token for publishing. Forward-only: never edit once applied.
--
-- Only the fact is stored here: that a token was set, and when. The token itself is never in the database: it is written to a Kubernetes Secret of
-- the team's pod namespace (by the hermes-pods plugin) and only the `repo` Unix user inside the pod can read it. A column that could hold the token
-- would be one more place to leak it from, so there is none.

ALTER TABLE app.projects ADD COLUMN push_credential_set_at timestamptz;
COMMENT ON COLUMN app.projects.push_credential_set_at IS 'When a GitHub token for publishing was set (null: none). The token is never stored in the database.';
