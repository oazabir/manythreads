-- files 0003: the blob GC's instance marker. Forward-only: never edit once applied.
--
-- DECISION (Phase 4 security review, M4): a garbage collector that deletes "every blob no local row names" is only right when the store belongs to
-- this database alone. Two deployments (staging and production) that share a bucket and prefix would each delete the other's blobs after the grace
-- period. The GC therefore keeps one random id here and the same id in the store (a hidden object beside the blobs, `BlobStorage.getInstanceMarker`),
-- and deletes only while the two are equal. The first run on a fresh pair writes both; a store whose marker is another id, or a database with no
-- marker facing a store that has one, is refused (docs/plugins/files.md, "Blob garbage collection": MANYTHREADS_BLOB_GC_ADOPT_MARKER adopts it
-- explicitly, for a database restored from a backup).
--
-- One row (`singleton`), system role only: it is read and written by the `files.blob-gc` job and by an operator as system.
CREATE TABLE app.blob_gc_instance (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id text NOT NULL CHECK (instance_id ~ '^[0-9a-f]{32}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.blob_gc_instance IS 'rls: system — S: the one id that ties this database to its blob store for the blob GC; the system role (the job) only.';
ALTER TABLE app.blob_gc_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.blob_gc_instance FORCE ROW LEVEL SECURITY;
CREATE POLICY blob_gc_instance_system ON app.blob_gc_instance FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
