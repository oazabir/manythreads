-- bookmarks 0001: the threads, messages and files a person keeps to find again (P36-08, docs/plans/bookmarks.md). Forward-only: never edit once applied.
--
-- PRIVATE TO THE PERSON. A person reads, adds and removes only their own rows; nobody else does, an admin included, and there is no admin or system
-- policy (no job reads them). The row holds ids and a path only, never any text: the list reads the item under the caller's own access every time, so
-- a deleted message, a channel the person left or a file they can no longer open shows "No longer available" and nothing else.
--
-- ONE ROW PER PERSON AND TARGET. Each kind fills its own columns (one CHECK per kind) and has its own partial unique index:
--   thread     thread_root_id (the first message) and channel_id
--   message    message_id, channel_id and, for a reply, thread_root_id
--   file       file_id (an attachment or a Personal file) and, for an attachment, channel_id
--   repo_file  team_id and path (a file of the team's repository, kept by its path: a rename leaves the bookmark on the old path)
-- message_id, thread_root_id and file_id have no foreign key on purpose: when the item is removed for good the bookmark stays and says so. channel_id
-- and team_id do (a deleted channel or team takes its bookmarks with it) and are what the insert policy checks.
--
-- Nothing is ever changed in place (a guard trigger refuses every UPDATE); a person removes a bookmark and adds another. At most 500 per person.

CREATE TABLE app.bookmarks (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  person_id      uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('thread', 'message', 'file', 'repo_file')),
  message_id     uuid,
  channel_id     uuid REFERENCES app.channels (id) ON DELETE CASCADE,
  thread_root_id uuid,
  file_id        uuid,
  team_id        uuid REFERENCES app.teams (id) ON DELETE CASCADE,
  path           text CHECK (length(path) BETWEEN 1 AND 1024),   -- a Postgres text never holds a NUL character, so none needs refusing here
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookmarks_thread_shape CHECK (kind <> 'thread' OR (
    thread_root_id IS NOT NULL AND channel_id IS NOT NULL AND message_id IS NULL AND file_id IS NULL AND team_id IS NULL AND path IS NULL)),
  CONSTRAINT bookmarks_message_shape CHECK (kind <> 'message' OR (
    message_id IS NOT NULL AND channel_id IS NOT NULL AND file_id IS NULL AND team_id IS NULL AND path IS NULL)),
  CONSTRAINT bookmarks_file_shape CHECK (kind <> 'file' OR (
    file_id IS NOT NULL AND message_id IS NULL AND thread_root_id IS NULL AND team_id IS NULL AND path IS NULL)),
  CONSTRAINT bookmarks_repo_file_shape CHECK (kind <> 'repo_file' OR (
    team_id IS NOT NULL AND path IS NOT NULL AND message_id IS NULL AND thread_root_id IS NULL AND file_id IS NULL AND channel_id IS NULL))
);
CREATE UNIQUE INDEX bookmarks_person_thread ON app.bookmarks (person_id, thread_root_id) WHERE kind = 'thread';
CREATE UNIQUE INDEX bookmarks_person_message ON app.bookmarks (person_id, message_id) WHERE kind = 'message';
CREATE UNIQUE INDEX bookmarks_person_file ON app.bookmarks (person_id, file_id) WHERE kind = 'file';
CREATE UNIQUE INDEX bookmarks_person_repo_file ON app.bookmarks (person_id, team_id, path) WHERE kind = 'repo_file';
-- the list: one person's bookmarks of a kind, newest first (uuid v7 sorts by time)
CREATE INDEX bookmarks_person_kind ON app.bookmarks (person_id, kind, id DESC);
CREATE INDEX bookmarks_workspace ON app.bookmarks (workspace_id);
CREATE INDEX bookmarks_channel ON app.bookmarks (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX bookmarks_team ON app.bookmarks (team_id) WHERE team_id IS NOT NULL;
COMMENT ON TABLE app.bookmarks IS 'rls: person — P: the threads, messages and files a person bookmarked; a person reads, adds and removes only their own, nobody else (an admin included). Ids and a path only, never any text.';

-- A bookmark is never changed in place, by anyone.
CREATE FUNCTION app.bookmarks_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'a bookmark is never changed; remove it and add another' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER bookmarks_guard BEFORE UPDATE ON app.bookmarks FOR EACH ROW EXECUTE FUNCTION app.bookmarks_guard();

-- At most 500 per person, also when two requests race: the person's inserts take turns on an advisory lock (released at commit), and the count sees
-- only the person's own rows (row-level security).
CREATE FUNCTION app.bookmarks_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bookmarks:' || NEW.person_id::text, 0));
  IF (SELECT count(*) FROM app.bookmarks WHERE person_id = NEW.person_id) >= 500 THEN
    RAISE EXCEPTION 'You have 500 bookmarks. Remove some first.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bookmarks_cap BEFORE INSERT ON app.bookmarks FOR EACH ROW EXECUTE FUNCTION app.bookmarks_cap();

ALTER TABLE app.bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bookmarks FORCE ROW LEVEL SECURITY;
CREATE POLICY bookmarks_select ON app.bookmarks FOR SELECT
  USING (person_id = (SELECT app.person_id()));
-- A person bookmarks only for themself, and only what they can see now: a thread or message of a channel they can read, a file their own file
-- policies show them, a repository file of a team they can read.
CREATE POLICY bookmarks_insert ON app.bookmarks FOR INSERT WITH CHECK (
  person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())
  AND CASE kind
    WHEN 'thread' THEN channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
    WHEN 'message' THEN channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
    WHEN 'file' THEN EXISTS (SELECT 1 FROM app.files f WHERE f.id = bookmarks.file_id)
    WHEN 'repo_file' THEN team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
    ELSE false
  END);
CREATE POLICY bookmarks_delete ON app.bookmarks FOR DELETE
  USING (person_id = (SELECT app.person_id()));

GRANT SELECT, INSERT, DELETE ON app.bookmarks TO manythreads_app;
