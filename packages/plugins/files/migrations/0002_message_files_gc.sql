-- files 0002: files of deleted messages, and what the blob GC needs. Forward-only: never edit once applied.
--
-- DECISION (PLAN P4-00, retro phase 3 follow-up "deleted-message files"): a file whose ONLY references are deleted messages is hidden, then
-- deleted with its bytes. Hidden at once: the `files_select` policy no longer shows a row with `orphaned_at` set to anyone but the system
-- role, so the download route, the channel's file list, the message cards, search and links all stop serving it (they all read through RLS;
-- 403 as for any hidden file). Deleted later: the `files.blob-gc` job removes the row after MANYTHREADS_FILES_ORPHAN_DAYS (30) and the
-- blob GC then removes the bytes. Why not delete with the message: a delete that fails half way or is a mistake (a lead deleting the wrong
-- message) would lose a file with no way back; the 30 days are the way back for an operator (clear `orphaned_at`). Why not keep: the message
-- was deleted to get rid of its content, and a file of it readable by every member of the channel forever contradicts that.
-- "Only references": a file that a live message still lists stays visible (the route lets two messages attach the same file), until the
-- last one is deleted. A file never attached to any message (uploaded, then abandoned) is not touched: it is the channel's file, listed in Files.
--
-- Mechanics: a definer trigger on `app.messages` (a table of the channels plugin; the files plugin depends on it) calls the definer function
-- `app.files_mark_orphaned(file ids)` when a message is deleted. The function stamps `orphaned_at` where no live message of the channel
-- still lists the file (the GIN index on `meta->'attachments'` makes that probe cheap). Existing deleted messages are backfilled below.

ALTER TABLE app.files ADD COLUMN orphaned_at timestamptz;
CREATE INDEX files_orphaned ON app.files (orphaned_at) WHERE orphaned_at IS NOT NULL;
-- The blob GC asks "which of these 1,000 blob keys has a row?" per page of the store listing.
CREATE INDEX files_blob_key ON app.files (blob_key);
-- Which messages list a file (`meta.attachments` is an array of file ids as text): `meta -> 'attachments' @> '"<id>"'`.
CREATE INDEX messages_attachments ON app.messages USING gin ((meta -> 'attachments') jsonb_path_ops);

-- Hidden rows are visible to the system role only (the GC reads and deletes them; an operator can clear the mark as system).
DROP POLICY files_select ON app.files;
CREATE POLICY files_select ON app.files FOR SELECT USING (
  (SELECT app.is_system())
  OR (orphaned_at IS NULL AND (
        channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
        OR (channel_id IS NULL AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])))));

-- The only UPDATE the table ever sees is the orphan stamp, written by the definer function below (current_user = the system role) or by the
-- system role itself: no policy for anyone else, and the app role has no UPDATE privilege.
CREATE POLICY files_update_system ON app.files FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- A stored file still does not change, except the orphan stamp (NULL to a time) and only when nothing else about the row moves. The app role
-- has no UPDATE privilege at all, so this is reached by the system role and by the definer function below.
CREATE OR REPLACE FUNCTION app.files_no_update() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF session_user = 'manythreads_system' THEN
    RETURN NEW;
  END IF;
  IF OLD.orphaned_at IS NULL AND NEW.orphaned_at IS NOT NULL AND (to_jsonb(NEW) - 'orphaned_at') = (to_jsonb(OLD) - 'orphaned_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a stored file does not change' USING ERRCODE = 'check_violation';
END
$$;

-- Stamps the files (of channels) that no live message lists any more. Idempotent; returns how many it stamped.
CREATE FUNCTION app.files_mark_orphaned(p_file_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE app.files f SET orphaned_at = now()
   WHERE f.id = ANY (p_file_ids) AND f.orphaned_at IS NULL AND f.channel_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM app.messages m
        WHERE m.channel_id = f.channel_id AND m.deleted_at IS NULL AND (m.meta -> 'attachments') @> to_jsonb(f.id::text));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

CREATE FUNCTION app.files_after_message_deleted() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF jsonb_typeof(NEW.meta -> 'attachments') = 'array' THEN
    PERFORM app.files_mark_orphaned(ARRAY(
      SELECT e::uuid FROM jsonb_array_elements_text(NEW.meta -> 'attachments') AS e
       WHERE e ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER files_after_message_deleted AFTER UPDATE OF deleted_at ON app.messages FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION app.files_after_message_deleted();

-- Nobody but the system role (and the trigger above, which runs as its owner) calls the marker.
REVOKE ALL ON FUNCTION app.files_mark_orphaned(uuid[]), app.files_after_message_deleted() FROM PUBLIC;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.files_mark_orphaned(uuid[]) OWNER TO manythreads_system;
ALTER FUNCTION app.files_after_message_deleted() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

-- Backfill: files whose messages were all deleted before this migration are hidden from now (and purged 30 days from now).
SELECT app.files_mark_orphaned(ARRAY(
  SELECT DISTINCT e::uuid
    FROM app.messages m,
         jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.meta -> 'attachments') = 'array' THEN m.meta -> 'attachments' ELSE '[]'::jsonb END) AS e
   WHERE m.deleted_at IS NOT NULL
     AND e ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
