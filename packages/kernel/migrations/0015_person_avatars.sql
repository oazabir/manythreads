-- 0015_person_avatars (P14-23): a person's profile picture. Forward-only: never edit this file once applied.
--
-- `people.avatar` holds the choice as one short text: `preset:<id>` (a built-in picture, drawn from the web app's own files), `photo:<16 hex>` (an uploaded
-- photo; the hex is the start of its hash and is part of the picture's address, so a new photo is never shown from an old cache) or NULL (neither: the web app
-- draws the person's initials). The photo bytes live in `person_photos`, one row per person, at most 256 KiB (the browser shrinks a photo to a 256-pixel square).
-- A person changes only their own row (the existing people_update policy); an admin may too.

ALTER TABLE app.people
  ADD COLUMN avatar text CHECK (avatar IS NULL OR avatar ~ '^(preset:[a-z0-9-]{1,40}|photo:[0-9a-f]{16})$');

CREATE TABLE app.person_photos (
  person_id    uuid PRIMARY KEY REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes        bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 12 AND 262144),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_photos_workspace ON app.person_photos (workspace_id);
COMMENT ON TABLE app.person_photos IS 'rls: person — P: a person writes and removes only their own photo; WR: non-guest members read every photo in their workspace, a guest only their own.';

ALTER TABLE app.person_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.person_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY person_photos_select ON app.person_photos FOR SELECT USING (
  app.is_system()
  OR person_id = app.person_id()
  OR (workspace_id = app.workspace_id() AND app.workspace_role() IN ('owner', 'admin', 'member'))
);
CREATE POLICY person_photos_insert ON app.person_photos FOR INSERT
  WITH CHECK (app.is_system() OR (person_id = app.person_id() AND workspace_id = app.workspace_id()));
CREATE POLICY person_photos_update ON app.person_photos FOR UPDATE
  USING (app.is_system() OR person_id = app.person_id())
  WITH CHECK (app.is_system() OR (person_id = app.person_id() AND workspace_id = app.workspace_id()));
CREATE POLICY person_photos_delete ON app.person_photos FOR DELETE USING (app.is_system() OR person_id = app.person_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON app.person_photos TO manythreads_app;
