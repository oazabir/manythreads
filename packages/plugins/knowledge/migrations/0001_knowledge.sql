-- knowledge 0001: a team's knowledge bases (PLAN P8-07, SPEC §12.4). Forward-only: never edit once applied.
--
--  * knowledge_bases:     a named folder of documents that bots search and cite, one per team and slug (`knowledge/<slug>/` in the team repo).
--  * knowledge_sources:   where documents come from. `upload` is a file a person uploaded (the original stays in blob storage); `repo` is a Markdown or
--                         text file someone put in the base's folder of the team repo. One row per kind per base, made when the base is.
--  * knowledge_documents: one row per document: its content hash, version, size, kind, and whether it is searchable (`indexed`) or could not be read
--                         (`failed`, with a plain reason). `version` goes up each time the content changes; the same content again changes nothing.
--  * knowledge_chunks:    the passages a document is cut into, at the version they were cut from. The newest versions are kept (the application prunes the
--                         rest) so a citation made earlier still resolves and can say the source has changed since. `tsv` is the word index;
--                         `embedding` stays empty until a workspace has an embedding model (nothing fills it today) and has no index of its own.
--
-- Every table carries `team_id` so the read policy is the hoisted team set; the composite foreign keys make a child's team agree with its parent's.
-- pgvector and pg_trgm are created by the kernel migration, so this file needs neither CREATE EXTENSION nor a guard.

CREATE TABLE app.knowledge_bases (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  slug         text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by   uuid        REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, slug),
  UNIQUE (id, team_id)
);
CREATE INDEX knowledge_bases_workspace ON app.knowledge_bases (workspace_id);
CREATE INDEX knowledge_bases_created_by ON app.knowledge_bases (created_by) WHERE created_by IS NOT NULL;
COMMENT ON TABLE app.knowledge_bases IS 'rls: team — T: readable by the people of the team (app.readable_team_ids read; not a guest); written by team leads and workspace admins (manage) and the system.';

CREATE TABLE app.knowledge_sources (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  base_id        uuid        NOT NULL,
  team_id        uuid        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('upload', 'repo')),
  last_synced_at timestamptz,
  error          text        CHECK (error IS NULL OR char_length(error) <= 400),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (base_id, team_id) REFERENCES app.knowledge_bases (id, team_id) ON DELETE CASCADE,
  UNIQUE (base_id, kind),
  UNIQUE (id, base_id)
);
CREATE INDEX knowledge_sources_team ON app.knowledge_sources (team_id);
COMMENT ON TABLE app.knowledge_sources IS 'rls: team — T: readable by the people of the team; written by team leads and workspace admins (manage) and the system.';

CREATE TABLE app.knowledge_documents (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  base_id      uuid        NOT NULL,
  team_id      uuid        NOT NULL,
  source_id    uuid        NOT NULL,
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  slug         text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,80}$'),
  kind         text        NOT NULL CHECK (kind IN ('markdown', 'text', 'csv', 'pdf')),
  size         bigint      NOT NULL CHECK (size >= 0),
  sha256       text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  version      integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  status       text        NOT NULL CHECK (status IN ('indexed', 'failed')),
  reason       text        CHECK (reason IS NULL OR char_length(reason) <= 400),
  blob_key     text        CHECK (blob_key IS NULL OR char_length(blob_key) BETWEEN 1 AND 128),
  repo_path    text        CHECK (repo_path IS NULL OR char_length(repo_path) <= 1024),
  repo_sha     text        CHECK (repo_sha IS NULL OR repo_sha ~ '^[0-9a-f]{40,64}$'),
  chunk_count  integer     NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  indexed_at   timestamptz,
  created_by   uuid        REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (base_id, team_id) REFERENCES app.knowledge_bases (id, team_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, base_id) REFERENCES app.knowledge_sources (id, base_id) ON DELETE CASCADE,
  UNIQUE (base_id, slug),
  UNIQUE (id, base_id)
);
CREATE UNIQUE INDEX knowledge_documents_name ON app.knowledge_documents (base_id, lower(name));
CREATE INDEX knowledge_documents_source ON app.knowledge_documents (source_id);
CREATE INDEX knowledge_documents_team ON app.knowledge_documents (team_id);
CREATE INDEX knowledge_documents_blob ON app.knowledge_documents (blob_key) WHERE blob_key IS NOT NULL;
CREATE INDEX knowledge_documents_created_by ON app.knowledge_documents (created_by) WHERE created_by IS NOT NULL;
COMMENT ON TABLE app.knowledge_documents IS 'rls: team — T: readable by the people of the team; written by team leads and workspace admins (manage) and the system. `blob_key` points at the original in blob storage (the files blob GC reads it).';

CREATE TABLE app.knowledge_chunks (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  document_id uuid        NOT NULL,
  base_id     uuid        NOT NULL,
  team_id     uuid        NOT NULL,
  ordinal     integer     NOT NULL CHECK (ordinal >= 0),
  version     integer     NOT NULL CHECK (version >= 1),
  -- the bound is a constraint, not application code: a claim that a search operator is leakproof needs the input bounded where the data lands
  text        text        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  section     text        CHECK (section IS NULL OR char_length(section) <= 200),
  char_start  integer     NOT NULL CHECK (char_start >= 0),
  char_end    integer     NOT NULL CHECK (char_end >= char_start),
  tsv         tsvector    GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  embedding   vector(768),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (document_id, base_id) REFERENCES app.knowledge_documents (id, base_id) ON DELETE CASCADE,
  FOREIGN KEY (base_id, team_id) REFERENCES app.knowledge_bases (id, team_id) ON DELETE CASCADE,
  UNIQUE (document_id, version, ordinal)
);
CREATE INDEX knowledge_chunks_base ON app.knowledge_chunks (base_id);
CREATE INDEX knowledge_chunks_team ON app.knowledge_chunks (team_id);
CREATE INDEX knowledge_chunks_tsv ON app.knowledge_chunks USING gin (tsv);
CREATE INDEX knowledge_chunks_trgm ON app.knowledge_chunks USING gin (text gin_trgm_ops);
COMMENT ON TABLE app.knowledge_chunks IS 'rls: team — T: readable by the people of the team; written by team leads and workspace admins (manage) and the system. Older versions of a document''s passages are kept for citations.';

-- RLS: every table is forced; reads are the hoisted team set, writes need to manage the team (lead or workspace admin). A guest reads nothing.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_bases', 'knowledge_sources', 'knowledge_documents', 'knowledge_chunks'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids(''read''))::uuid[]))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR INSERT WITH CHECK ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids(''manage''))::uuid[]))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR UPDATE USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids(''manage''))::uuid[])) WITH CHECK ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids(''manage''))::uuid[]))', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR DELETE USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids(''manage''))::uuid[]))', t || '_delete', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON app.%I TO manythreads_app', t);
  END LOOP;
END
$$;

-- The caps are the database's, not only the route's: a count in the route is passed by two requests at once or by any other writer. A lock per parent
-- makes inserts take turns; the count runs under the caller's own read policy, which always includes the parent's team.
CREATE FUNCTION app.knowledge_bases_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge_bases:' || NEW.team_id::text, 0));
  IF (SELECT count(*) FROM app.knowledge_bases WHERE team_id = NEW.team_id) >= 20 THEN
    RAISE EXCEPTION 'A team can have at most 20 knowledge bases.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.knowledge_bases_cap() FROM PUBLIC;
CREATE TRIGGER knowledge_bases_cap BEFORE INSERT ON app.knowledge_bases FOR EACH ROW EXECUTE FUNCTION app.knowledge_bases_cap();

CREATE FUNCTION app.knowledge_documents_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge_documents:' || NEW.base_id::text, 0));
  IF (SELECT count(*) FROM app.knowledge_documents WHERE base_id = NEW.base_id) >= 200 THEN
    RAISE EXCEPTION 'A knowledge base can hold at most 200 documents.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.knowledge_documents_cap() FROM PUBLIC;
CREATE TRIGGER knowledge_documents_cap BEFORE INSERT ON app.knowledge_documents FOR EACH ROW EXECUTE FUNCTION app.knowledge_documents_cap();

-- Which bases the calling run's bot may search. The tool runs as the person who asked (so row-level security decides what they may read), but the
-- bot's own list is on the bot's row, which that person may not be able to read. This answers only for `app.run_id()`, only while the run is live,
-- and only with the bot's team and its `knowledge` list (NULL until the bot's BOT.md has been loaded since the column existed).
CREATE FUNCTION app.knowledge_run_grant() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE r record;
BEGIN
  SELECT b.id AS bot_id, b.team_id, b.knowledge INTO r
    FROM app.bot_runs br JOIN app.bots b ON b.id = br.bot_id
   WHERE br.id = app.run_id() AND br.status = 'running' AND br.ended_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('botId', r.bot_id, 'teamId', r.team_id, 'knowledge', r.knowledge);
END
$$;
REVOKE ALL ON FUNCTION app.knowledge_run_grant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.knowledge_run_grant() TO manythreads_app, manythreads_system;

-- Owned by the system role like every other definer function (a login that can set up the schema would otherwise be the one whose rights these run with).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.knowledge_run_grant() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
