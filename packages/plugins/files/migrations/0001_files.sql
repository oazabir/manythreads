-- files 0001: the `files` table of attachments in Files storage (PLAN.md A.3, P3-08; SPEC section 5.2, principle 8). Forward-only.
--
-- A channel file is readable by exactly the people who can read its channel (`app.visible_channel_ids('read')`, channels 0001), judged on EVERY
-- read from the row, not from a link or a token; it is created by someone who may post there. A file without a channel belongs to a team
-- (Files, phase 4) and follows the team's read set. Bytes live in the storage provider under `blob_key`; this table is the only way to a blob.
-- Depends on the channels plugin (channels, visible_channel_ids): the files plugin declares `dependsOn: ['channels']`.

CREATE TABLE app.files (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  team_id      uuid REFERENCES app.teams (id) ON DELETE CASCADE,      -- null for a DM or bot conversation; set from the channel by a trigger
  channel_id   uuid REFERENCES app.channels (id) ON DELETE CASCADE,
  folder_path  text NOT NULL CHECK (length(folder_path) BETWEEN 2 AND 512 AND folder_path LIKE '%/' AND folder_path !~ '(^|/)\.\.?(/|$)'),
  name         text NOT NULL CHECK (
                 length(name) BETWEEN 1 AND 255 AND name NOT IN ('.', '..') AND name !~ '[/\\]' AND name !~ '[[:cntrl:]]'),
  blob_key     text NOT NULL CHECK (length(blob_key) BETWEEN 1 AND 128),
  size         bigint NOT NULL CHECK (size >= 0),
  mime         text NOT NULL CHECK (length(mime) BETWEEN 1 AND 255),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploader_id  uuid NOT NULL REFERENCES app.actors (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT files_has_owner CHECK (channel_id IS NOT NULL OR team_id IS NOT NULL)
);
-- One name per folder of a channel (the route renames "report.pdf" to "report (2).pdf"); Files of a team get their own rule in phase 4.
CREATE UNIQUE INDEX files_channel_folder_name ON app.files (channel_id, folder_path, name) WHERE channel_id IS NOT NULL;
CREATE INDEX files_channel_id_desc ON app.files (channel_id, id DESC) WHERE channel_id IS NOT NULL;
CREATE INDEX files_team ON app.files (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX files_uploader ON app.files (uploader_id);
CREATE INDEX files_name_trgm ON app.files USING gin (name gin_trgm_ops);
COMMENT ON TABLE app.files IS 'rls: team — C: attachments of the channels the caller can read (app.visible_channel_ids), T for a team file; created by someone who may post there, deleted by the uploader or a team lead.';

-- A file belongs to its channel's workspace and team: the caller names the channel, never the team.
CREATE FUNCTION app.files_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws   uuid;
  v_team uuid;
BEGIN
  IF NEW.channel_id IS NOT NULL THEN
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
CREATE TRIGGER files_before_insert BEFORE INSERT ON app.files FOR EACH ROW EXECUTE FUNCTION app.files_before_insert();

-- Nothing but the system role changes a stored file: name, bytes and owner are fixed once written.
CREATE FUNCTION app.files_no_update() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'a stored file does not change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER files_no_update BEFORE UPDATE ON app.files FOR EACH ROW EXECUTE FUNCTION app.files_no_update();

ALTER TABLE app.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.files FORCE ROW LEVEL SECURITY;
-- Read: the hoisted channel set (one array probe per statement), or the team set for a file with no channel.
CREATE POLICY files_select ON app.files FOR SELECT USING (
  (SELECT app.is_system())
  OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
  OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])));
CREATE POLICY files_insert ON app.files FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (
    workspace_id = (SELECT app.workspace_id()) AND uploader_id = (SELECT app.actor())
    AND (channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])
         OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])))));
-- Delete is a single-row decision: the uploader (who can still read the channel) or a lead of the team (channel_can 'manage').
CREATE POLICY files_delete ON app.files FOR DELETE USING (
  (SELECT app.is_system())
  OR (uploader_id = (SELECT app.actor())
      AND (channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]) OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))))
  OR (channel_id IS NOT NULL AND app.channel_can(channel_id, 'manage'))
  OR (channel_id IS NULL AND app.can_in_team(team_id, 'manage')));

GRANT SELECT, INSERT, DELETE ON app.files TO manythreads_app;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.files_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.files_no_update() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
