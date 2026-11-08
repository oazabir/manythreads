-- retention 0002: recorded meeting audio is kept for a while and then deleted (PLAN P15-15, decision C11; docs/plugins/retention.md "meeting audio").
-- Forward-only: never edit once applied.
--
--  * app.meeting_recordings gains `delete_after`: the instant the recorded file may be deleted. The meetings plugin writes it when it closes a person's file
--    (stopped_at plus the team's `TEAM.md` `meetings.keepAudioDays`, 30 days when the file says nothing); the sweep only reads it. A row without it (a file made by a
--    server that did not know the column) is kept 30 days from `stopped_at`.
--  * an index for the sweep: a workspace's recordings that still hold a file, by the day they expire.
--
-- The recordings table belongs to the meetings plugin; the manifest's `dependsOn` puts this migration after it. The guard keeps the file harmless in a database that
-- has no meetings tables (a test that loads only retention): there is nothing to expire there.

DO $$
BEGIN
  IF to_regclass('app.meeting_recordings') IS NOT NULL THEN
    ALTER TABLE app.meeting_recordings ADD COLUMN IF NOT EXISTS delete_after timestamptz;
    CREATE INDEX IF NOT EXISTS meeting_recordings_expiry ON app.meeting_recordings (workspace_id, delete_after, id) WHERE file_id IS NOT NULL AND stopped_at IS NOT NULL;
    COMMENT ON COLUMN app.meeting_recordings.delete_after IS 'The retention sweep deletes the recorded file (the Files row; the bytes go with the blob collector) once this instant has passed. Written by the meetings plugin when the file is closed.';
  END IF;
END
$$;
