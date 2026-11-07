-- files 0005 (P20-02): a person's Personal files. Forward-only: never edit once applied.
--
-- WHAT THIS ADDS
--   app.files.owner_person_id   a file may belong to one person instead of a channel or a team (their Personal space, kernel 0016). Such a row has
--                               neither channel_id nor team_id. The rows keep the same blob_key / size / mime / sha256 as a channel file.
--   app.files.updated_at/by     the last time the content or the place (name, folder) of a Personal file changed. NULL for a file that never changed.
--   app.file_versions           the older contents of a Personal file, kept so a note can be restored. The CURRENT content lives in app.files; a save
--                               or a restore moves the content it replaces into one row here. A blob is named by exactly one row (never shared).
--   app.personal_folders        a Personal space's folders, so an empty folder exists (the seven starting folders, and any the person makes).
--
-- THE ACCESS RULE is the space template of kernel 0016 (docs/plugins/README.md "space policy shape"): read = the person's own id, or a person whose space
-- the caller holds a LIVE audited open on (app.readable_space_ids('read')); write = the owner only, and never a guest (a guest has no Personal space).
-- An admin's open is read-only by these policies: no policy below names an admin, and 'post' never contains another person.
--
-- files_no_update (0001/0002) still says "a stored file does not change" for everyone but the system role, with two exceptions: the orphan stamp
-- (0002) and now the Personal file's own columns (name, folder, bytes, size, type, hash, updated_*) when the owner changes them. Identity, workspace,
-- owner, uploader and creation time never change.

ALTER TABLE app.files ADD COLUMN owner_person_id uuid REFERENCES app.people (id) ON DELETE CASCADE;
-- Nullable, no default: a default would stamp every old row with the instant of this migration (MISTAKES P5-13).
ALTER TABLE app.files ADD COLUMN updated_at timestamptz;
ALTER TABLE app.files ADD COLUMN updated_by uuid REFERENCES app.actors (id) ON DELETE SET NULL;

ALTER TABLE app.files DROP CONSTRAINT files_has_owner;
-- Exactly one owner: a channel or a team (as before), or a person with neither.
ALTER TABLE app.files ADD CONSTRAINT files_has_owner CHECK (
  (owner_person_id IS NULL AND (channel_id IS NOT NULL OR team_id IS NOT NULL))
  OR (owner_person_id IS NOT NULL AND channel_id IS NULL AND team_id IS NULL));

-- One name per folder of a person's space (also the index that answers "this person's files": its first column is the FK).
CREATE UNIQUE INDEX files_owner_folder_name ON app.files (owner_person_id, folder_path, name) WHERE owner_person_id IS NOT NULL;
CREATE INDEX files_updated_by ON app.files (updated_by) WHERE updated_by IS NOT NULL;

-- The trigger that fixes a file's workspace and team knew two owners; it now knows a third (the person's own workspace is checked).
CREATE OR REPLACE FUNCTION app.files_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws   uuid;
  v_team uuid;
BEGIN
  IF NEW.owner_person_id IS NOT NULL THEN
    SELECT p.workspace_id INTO v_ws FROM app.people p WHERE p.id = NEW.owner_person_id;
    IF v_ws IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'a file belongs to its owner''s workspace' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.channel_id IS NOT NULL THEN
    SELECT c.workspace_id, c.team_id INTO v_ws, v_team FROM app.channels c WHERE c.id = NEW.channel_id;
    IF v_ws IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'a file belongs to its channel''s workspace' USING ERRCODE = 'check_violation';
    END IF;
    NEW.team_id := v_team;
  ELSE
    SELECT t.workspace_id INTO v_ws FROM app.teams t WHERE t.id = NEW.team_id;
    IF v_ws IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'a file belongs to its team''s workspace' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.files_no_update() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_moving text[] := ARRAY['name', 'folder_path', 'blob_key', 'size', 'mime', 'sha256', 'updated_at', 'updated_by'];
BEGIN
  IF session_user = 'manythreads_system' THEN
    RETURN NEW;
  END IF;
  IF OLD.orphaned_at IS NULL AND NEW.orphaned_at IS NOT NULL AND (to_jsonb(NEW) - 'orphaned_at') = (to_jsonb(OLD) - 'orphaned_at') THEN
    RETURN NEW;
  END IF;
  -- A Personal file: the owner may rename it, move it, and replace its content; nothing else about the row moves.
  IF OLD.owner_person_id IS NOT NULL AND NEW.owner_person_id = OLD.owner_person_id
     AND (to_jsonb(NEW) - v_moving) = (to_jsonb(OLD) - v_moving) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a stored file does not change' USING ERRCODE = 'check_violation';
END
$$;

-- app.file_versions ------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.file_versions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  file_id         uuid NOT NULL REFERENCES app.files (id) ON DELETE CASCADE,
  -- Copied from the file by the trigger below (the caller does not choose it): the hoisted policy reads it without a join.
  owner_person_id uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  blob_key        text NOT NULL CHECK (length(blob_key) BETWEEN 1 AND 128),
  size            bigint NOT NULL CHECK (size >= 0),
  mime            text NOT NULL CHECK (length(mime) BETWEEN 1 AND 255),
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  author_actor_id uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  -- When this content became the file's content (not when it was put aside).
  stored_at       timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_versions_file ON app.file_versions (file_id, created_at DESC, id DESC);
CREATE INDEX file_versions_owner ON app.file_versions (owner_person_id);
CREATE INDEX file_versions_workspace ON app.file_versions (workspace_id);
CREATE INDEX file_versions_author ON app.file_versions (author_actor_id) WHERE author_actor_id IS NOT NULL;
CREATE INDEX file_versions_blob_key ON app.file_versions (blob_key);
CREATE INDEX file_versions_created_brin ON app.file_versions USING brin (created_at);
COMMENT ON TABLE app.file_versions IS 'rls: person — P: the older contents of a Personal file, readable by its owner (and by an admin during a live audited open); added by the owner, removed by the system role only (a pruning job, or the file''s deletion).';

CREATE FUNCTION app.file_versions_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_owner uuid;
  v_ws    uuid;
BEGIN
  SELECT f.owner_person_id, f.workspace_id INTO v_owner, v_ws FROM app.files f WHERE f.id = NEW.file_id;
  IF v_owner IS NULL OR v_ws IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'only a Personal file keeps versions' USING ERRCODE = 'check_violation';
  END IF;
  NEW.owner_person_id := v_owner;
  RETURN NEW;
END
$$;
CREATE TRIGGER file_versions_before_insert BEFORE INSERT ON app.file_versions FOR EACH ROW EXECUTE FUNCTION app.file_versions_before_insert();

-- A version never changes.
CREATE FUNCTION app.file_versions_no_update() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'a file version does not change' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER file_versions_no_update BEFORE UPDATE ON app.file_versions FOR EACH ROW EXECUTE FUNCTION app.file_versions_no_update();

ALTER TABLE app.file_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.file_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY file_versions_select ON app.file_versions FOR SELECT USING (
  (SELECT app.is_system())
  OR owner_person_id = ANY ((SELECT app.readable_space_ids('read'))::uuid[]));
CREATE POLICY file_versions_insert ON app.file_versions FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND owner_person_id = (SELECT app.person_id())
      AND (SELECT app.lookup_workspace_role()) IN ('owner', 'admin', 'member')));
CREATE POLICY file_versions_delete ON app.file_versions FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT ON app.file_versions TO manythreads_app;

-- app.personal_folders ---------------------------------------------------------------------------------------------------------------
CREATE TABLE app.personal_folders (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  owner_person_id uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  -- No leading or trailing slash: 'Notes', 'Notes/2026'. A file's folder_path is this plus '/'.
  path            text NOT NULL CHECK (
                    length(path) BETWEEN 1 AND 500 AND path !~ '^/|/$|//' AND path !~ '(^|/)\.\.?(/|$)' AND path !~ '[[:cntrl:]\\]'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_person_id, path)
);
CREATE INDEX personal_folders_workspace ON app.personal_folders (workspace_id);
COMMENT ON TABLE app.personal_folders IS 'rls: person — P: the folders of a Personal space (so an empty folder exists); readable by the owner (and by an admin during a live audited open), made and removed by the owner.';
ALTER TABLE app.personal_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.personal_folders FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_folders_select ON app.personal_folders FOR SELECT USING (
  (SELECT app.is_system())
  OR owner_person_id = ANY ((SELECT app.readable_space_ids('read'))::uuid[]));
CREATE POLICY personal_folders_insert ON app.personal_folders FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND owner_person_id = (SELECT app.person_id())
      AND (SELECT app.lookup_workspace_role()) IN ('owner', 'admin', 'member')));
CREATE POLICY personal_folders_delete ON app.personal_folders FOR DELETE USING (
  (SELECT app.is_system()) OR owner_person_id = (SELECT app.person_id()));
GRANT SELECT, INSERT, DELETE ON app.personal_folders TO manythreads_app;

-- app.files policies -------------------------------------------------------------------------------------------------------------------
DROP POLICY files_select ON app.files;
CREATE POLICY files_select ON app.files FOR SELECT USING (
  (SELECT app.is_system())
  OR (orphaned_at IS NULL AND (
        channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
        OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))
        OR owner_person_id = ANY ((SELECT app.readable_space_ids('read'))::uuid[]))));

DROP POLICY files_insert ON app.files;
CREATE POLICY files_insert ON app.files FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (
    workspace_id = (SELECT app.workspace_id()) AND uploader_id = (SELECT app.actor())
    AND (channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])
         OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]))
         OR (owner_person_id = (SELECT app.person_id()) AND (SELECT app.lookup_workspace_role()) IN ('owner', 'admin', 'member')))));

-- Delete: the uploader, or a lead of the team (channel_can / can_in_team 'manage'), or the owner of a Personal file. The team branch now asks for a
-- team: can_in_team(NULL, ...) must never be a way for an admin to delete a Personal file.
DROP POLICY files_delete ON app.files;
CREATE POLICY files_delete ON app.files FOR DELETE USING (
  (SELECT app.is_system())
  OR (owner_person_id IS NOT NULL AND owner_person_id = (SELECT app.person_id()))
  OR (owner_person_id IS NULL AND uploader_id = (SELECT app.actor())
      AND (channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]) OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))))
  OR (owner_person_id IS NULL AND channel_id IS NOT NULL AND app.channel_can(channel_id, 'manage'))
  OR (owner_person_id IS NULL AND channel_id IS NULL AND team_id IS NOT NULL AND app.can_in_team(team_id, 'manage')));

-- Update: the owner of a Personal file (the trigger limits what may move). The existing system policy stays.
CREATE POLICY files_update_owner ON app.files FOR UPDATE
  USING (owner_person_id = (SELECT app.person_id()) AND (SELECT app.lookup_workspace_role()) IN ('owner', 'admin', 'member'))
  WITH CHECK (owner_person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()));
GRANT UPDATE (name, folder_path, blob_key, size, mime, sha256, updated_at, updated_by) ON app.files TO manythreads_app;

COMMENT ON TABLE app.files IS 'rls: team — C: attachments of the channels the caller can read (app.visible_channel_ids), T for a team file; P for a Personal file (owner_person_id): its owner, and an admin during a live audited open, read it; only its owner changes or deletes it. Created by someone who may post there, deleted by the uploader or a team lead.';

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.file_versions_before_insert() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
