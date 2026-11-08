-- knowledge 0005: document sources that ride on a person's connection (PLAN Bundle D, decisions D12-D15). Forward-only: never edit once applied.
--
-- A CONNECTOR SOURCE reads the documents of one folder, space, site or database at Notion, Confluence, Google Drive, SharePoint, OneDrive, Dropbox or Box with a
-- connection (a "grant") a person made, and keeps them in a base as ordinary documents. What it adds to the table of sources:
--
--   provider            which service the documents are read from
--   connection_id       the grant it is read with. NOT a foreign key: the connections plugin is a different plugin and a knowledge database may be migrated without it.
--                       The sync pauses the source (status `paused`) when it finds the grant gone.
--   granted_by          the person whose grant it is, so the source can say "read with Nadia's Google Drive" and pause when that person leaves
--   remote_root         the folder / space / site and drive / database id at the provider (an id, never a secret)
--   cursor              the provider's own change token, so a pass reads only what changed
--   status              ready | attention (the last pass failed) | paused (the grant is gone or the person's connection needs reconnecting)
--   skipped_limited     how many documents the last pass left out because not everyone on the team can open them at the source (a count, never names)
--   document_count      how many documents the last pass left in the base (so a screen needs no count query)
--
-- Each DOCUMENT of a connector source remembers where it came from: remote_id, remote_version (the provider's version or hash), remote_url. One document per
-- (source, remote_id). A removed or trashed remote file removes the document; its old passages stay for citations, as before.
--
-- A personal base may hold connector sources (0004's "no repo source" rule is kept). A base holds at most 10 connector sources.

ALTER TABLE app.knowledge_sources
  ADD COLUMN provider        text CHECK (provider IS NULL OR provider IN ('notion', 'confluence', 'google_drive', 'sharepoint', 'onedrive', 'dropbox', 'box')),
  ADD COLUMN connection_id   uuid,
  ADD COLUMN granted_by      uuid REFERENCES app.people (id) ON DELETE SET NULL,
  ADD COLUMN remote_root     text CHECK (remote_root IS NULL OR char_length(remote_root) BETWEEN 1 AND 1024),
  ADD COLUMN cursor          text CHECK (cursor IS NULL OR char_length(cursor) <= 4096),
  ADD COLUMN status          text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'attention', 'paused')),
  ADD COLUMN skipped_limited integer NOT NULL DEFAULT 0 CHECK (skipped_limited >= 0),
  ADD COLUMN document_count  integer NOT NULL DEFAULT 0 CHECK (document_count >= 0);
CREATE INDEX knowledge_sources_granted_by ON app.knowledge_sources (granted_by) WHERE granted_by IS NOT NULL;
CREATE INDEX knowledge_sources_connection ON app.knowledge_sources (connection_id) WHERE connection_id IS NOT NULL;

ALTER TABLE app.knowledge_sources DROP CONSTRAINT knowledge_sources_kind_check;
ALTER TABLE app.knowledge_sources ADD CONSTRAINT knowledge_sources_kind_check CHECK (kind IN ('upload', 'repo', 'url', 'connector'));
-- a connector source names its service and its root; no other kind carries either
ALTER TABLE app.knowledge_sources ADD CONSTRAINT knowledge_sources_connector_shape CHECK (
  (kind = 'connector') = (provider IS NOT NULL AND remote_root IS NOT NULL)
  AND (kind = 'connector' OR (connection_id IS NULL AND granted_by IS NULL AND cursor IS NULL))
);
-- many connector sources per base, like web pages: the unique-per-kind index leaves them out; one source per (service, root, grant) instead
DROP INDEX app.knowledge_sources_one_of_kind;
CREATE UNIQUE INDEX knowledge_sources_one_of_kind ON app.knowledge_sources (base_id, kind) WHERE kind NOT IN ('url', 'connector');
CREATE UNIQUE INDEX knowledge_sources_connector_root ON app.knowledge_sources (base_id, provider, remote_root) WHERE kind = 'connector';
-- the personal-base rule of 0004: no repo source; a connector source is allowed
ALTER TABLE app.knowledge_sources DROP CONSTRAINT knowledge_sources_personal_kind;
ALTER TABLE app.knowledge_sources ADD CONSTRAINT knowledge_sources_personal_kind CHECK (owner_person_id IS NULL OR kind IN ('upload', 'url', 'connector'));

-- The cap: 10 connector sources per base, 20 web-page sources as before; one lock per base makes inserts take turns (MISTAKES P10-04).
CREATE OR REPLACE FUNCTION app.knowledge_sources_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.kind IN ('url', 'connector') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('knowledge_sources:' || NEW.base_id::text, 0));
    IF NEW.kind = 'url' AND (SELECT count(*) FROM app.knowledge_sources WHERE base_id = NEW.base_id AND kind = 'url') >= 20 THEN
      RAISE EXCEPTION 'A knowledge base can have at most 20 web-page sources.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'connector' AND (SELECT count(*) FROM app.knowledge_sources WHERE base_id = NEW.base_id AND kind = 'connector') >= 10 THEN
      RAISE EXCEPTION 'A knowledge base can have at most 10 sources from connected apps.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Documents ---------------------------------------------------------------------------------------------------------------------------------------
-- The extractor reads Word, Excel and PowerPoint files for connector documents (a Drive or OneDrive folder holds them); an upload still refuses them (the route decides).
ALTER TABLE app.knowledge_documents DROP CONSTRAINT knowledge_documents_kind_check;
ALTER TABLE app.knowledge_documents ADD CONSTRAINT knowledge_documents_kind_check CHECK (kind IN ('markdown', 'text', 'csv', 'pdf', 'docx', 'xlsx', 'pptx'));
ALTER TABLE app.knowledge_documents
  ADD COLUMN remote_id      text CHECK (remote_id IS NULL OR char_length(remote_id) BETWEEN 1 AND 1024),
  ADD COLUMN remote_version text CHECK (remote_version IS NULL OR char_length(remote_version) <= 512),
  ADD COLUMN remote_url     text CHECK (remote_url IS NULL OR char_length(remote_url) BETWEEN 8 AND 2048);
ALTER TABLE app.knowledge_documents ADD CONSTRAINT knowledge_documents_remote_shape CHECK (remote_id IS NOT NULL OR (remote_version IS NULL AND remote_url IS NULL));
CREATE UNIQUE INDEX knowledge_documents_remote ON app.knowledge_documents (source_id, remote_id) WHERE remote_id IS NOT NULL;

-- A paused source needs a person's attention like a failed one: the base says so.
CREATE OR REPLACE FUNCTION app.knowledge_base_refresh_status(p_base uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.knowledge_bases b SET status = CASE
      WHEN EXISTS (SELECT 1 FROM app.knowledge_documents d WHERE d.base_id = b.id AND d.status = 'failed')
        OR EXISTS (SELECT 1 FROM app.knowledge_sources s WHERE s.base_id = b.id AND (s.error IS NOT NULL OR s.status <> 'ready')) THEN 'attention'
      WHEN NOT EXISTS (SELECT 1 FROM app.knowledge_documents d WHERE d.base_id = b.id) THEN 'empty'
      ELSE 'ready' END
   WHERE b.id = p_base;
END
$$;
DROP TRIGGER knowledge_sources_status ON app.knowledge_sources;
CREATE TRIGGER knowledge_sources_status AFTER INSERT OR DELETE OR UPDATE OF error, status ON app.knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION app.knowledge_base_status_trigger();

COMMENT ON TABLE app.knowledge_sources IS 'rls: team — T: as knowledge_bases; P for a source of a person''s base (an upload, a web address or a connected app, never the repo). A connector source names its grant by id only (connection_id, no tokens).';
