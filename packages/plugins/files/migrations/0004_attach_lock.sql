-- files 0004: close the race between "the last message that lists a file is deleted" and "another message attaches it". Forward-only.
--
-- The problem (Phase 4 review, L5): uploader deletes message M1 while a concurrent request posts M2 attaching the same file. The trigger of
-- 0002 asks "does a live message still list it?" with a snapshot that cannot see M2 (uncommitted), stamps the file `orphaned_at`, and 30 days
-- later the file and its bytes are purged although M2 is live.
--
-- The fix is an ordering protocol on the file's row, so each side sees the other's result:
--   * the posting path calls `app.files_lock_for_attach(ids)` (a row lock FOR SHARE, taken before it validates the attachments and inserts the
--     message; the app role has no UPDATE privilege, so the lock is taken by this definer function);
--   * `app.files_mark_orphaned` takes FOR UPDATE on the same rows in a statement of its own BEFORE the NOT EXISTS probe. In READ COMMITTED
--     every statement of a plpgsql function takes a new snapshot, so the probe, run after the lock was granted, sees M2 if its transaction
--     committed first; and if the stamp committed first, the poster's own validation (as the caller, under the row level security that hides
--     orphaned rows) no longer finds the file and the post is refused.
-- Both lock in id order, so two sides locking several files cannot deadlock each other.

CREATE FUNCTION app.files_lock_for_attach(p_file_ids uuid[]) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT 1 FROM app.files WHERE id = ANY (p_file_ids) ORDER BY id FOR SHARE
$$;
REVOKE ALL ON FUNCTION app.files_lock_for_attach(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.files_lock_for_attach(uuid[]) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.files_lock_for_attach(uuid[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

-- Same body as 0002 with the lock in front (the owner stays the system role: this migration runs as a superuser).
CREATE OR REPLACE FUNCTION app.files_mark_orphaned(p_file_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  -- Wait for a poster that holds the file (files_lock_for_attach); the statement below then runs with a snapshot taken after it committed.
  PERFORM 1 FROM app.files f WHERE f.id = ANY (p_file_ids) AND f.orphaned_at IS NULL AND f.channel_id IS NOT NULL ORDER BY f.id FOR UPDATE;
  UPDATE app.files f SET orphaned_at = now()
   WHERE f.id = ANY (p_file_ids) AND f.orphaned_at IS NULL AND f.channel_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM app.messages m
        WHERE m.channel_id = f.channel_id AND m.deleted_at IS NULL AND (m.meta -> 'attachments') @> to_jsonb(f.id::text));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
