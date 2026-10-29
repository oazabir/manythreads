-- search 0005: saved searches (PLAN P14-11). Forward-only: never edit once applied.
--
-- A saved search is a name and the text of the search box ("from:nadia in:dev has:file rollback"). It stores no result and no list of channels
-- or people: every time it is run, it runs as the person who opens it, through the same read policies as any search, so a search kept before a
-- person lost access to a private channel simply stops finding that channel's messages. The text may name a private channel; only its owner
-- can read the row.
CREATE TABLE app.saved_searches (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  owner_id     uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  query        text NOT NULL CHECK (char_length(query) BETWEEN 2 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_searches_owner ON app.saved_searches (owner_id, id);
CREATE INDEX saved_searches_workspace ON app.saved_searches (workspace_id);
-- one name per person, whatever the letter case
CREATE UNIQUE INDEX saved_searches_owner_name ON app.saved_searches (owner_id, lower(name));
COMMENT ON TABLE app.saved_searches IS 'rls: person — P: a person''s own saved searches (a name and the search box text); nobody else reads or changes them, not even an admin.';

ALTER TABLE app.saved_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.saved_searches FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_searches_select ON app.saved_searches FOR SELECT
  USING ((SELECT app.is_system()) OR owner_id = (SELECT app.actor()));
CREATE POLICY saved_searches_insert ON app.saved_searches FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND owner_id = (SELECT app.actor())));
CREATE POLICY saved_searches_delete ON app.saved_searches FOR DELETE
  USING ((SELECT app.is_system()) OR owner_id = (SELECT app.actor()));
GRANT SELECT, INSERT, DELETE ON app.saved_searches TO manythreads_app;
