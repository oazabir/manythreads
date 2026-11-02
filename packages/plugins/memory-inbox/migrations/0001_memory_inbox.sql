-- memory-inbox 0001: the team memory inbox (PLAN P8-14, SPEC §12.2). Forward-only: never edit once applied.
--
--  * memory_inbox_items:    one row per drop (a file, a note, a link, a message sent to memory, a mail or an attachment of one). `state` is where it is on
--                           its way, `stage` which step of the pipeline runs next (so a crashed job resumes where it stopped), `hold_reason` why a held
--                           item is held. `blob_key` points at the original in blob storage (the files blob GC reads it); it is cleared when a discard or
--                           the team's keep-originals time removes the original. `files_id` is reserved for the Files tree's `inbox/` folder.
--  * memory_inbox_extracts: the text of an item once it has been read, the sections it was cut into and, later, what the Archivist proposed. Only the
--                           system role reads it: a person sees the item, never the platform's working copy, and a held item never gets one.
--
-- The text a model reads is never stored on the item itself, so a list of items (the board) never carries content. Every table carries `team_id`, so
-- the read policy is the hoisted team set; a held item is visible only to its dropper and to the team's leads and the workspace's admins.

CREATE TABLE app.memory_inbox_items (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id       uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id            uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  parent_id          uuid        REFERENCES app.memory_inbox_items (id) ON DELETE CASCADE,
  origin             text        NOT NULL CHECK (origin IN ('person', 'message', 'email', 'share', 'bot')),
  state              text        NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'extracting', 'filing', 'filed', 'held', 'failed', 'duplicate', 'needs_review', 'discarded')),
  stage              text        NOT NULL DEFAULT 'hold' CHECK (stage IN ('hold', 'extract', 'distil', 'commit', 'done')),
  kind               text        NOT NULL CHECK (kind IN ('markdown', 'text', 'csv', 'pdf', 'docx', 'pptx', 'xlsx', 'eml', 'html', 'image', 'audio', 'video', 'link', 'bundle', 'unknown')),
  name               text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  size               bigint      NOT NULL CHECK (size >= 0),
  sha256             text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  blob_key           text        CHECK (blob_key IS NULL OR char_length(blob_key) BETWEEN 1 AND 128),
  files_id           uuid        REFERENCES app.files (id) ON DELETE SET NULL,
  dropper_id         uuid        REFERENCES app.actors (id) ON DELETE SET NULL,
  -- the dropper's name when they dropped it: `people` and `actors` show a caller only their own row, so a list cannot join to it
  dropper_name       text        CHECK (dropper_name IS NULL OR char_length(dropper_name) <= 200),
  team_only          boolean     NOT NULL DEFAULT false,
  reason             text        CHECK (reason IS NULL OR char_length(reason) <= 400),
  hold_reason        text        CHECK (hold_reason IS NULL OR hold_reason IN ('review_all', 'unknown_sender', 'failed_sender_check', 'foreign_bundle', 'dlp', 'oversize')),
  duplicate_of       uuid        REFERENCES app.memory_inbox_items (id) ON DELETE SET NULL,
  -- where a "send to memory" message came from: provenance only, no key (the message may be deleted later)
  source_channel_id  uuid,
  source_message_id  uuid,
  sender             text        CHECK (sender IS NULL OR char_length(sender) <= 320),
  sender_check       text        CHECK (sender_check IS NULL OR sender_check IN ('pass', 'fail', 'none')),
  filed_paths        text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(filed_paths) <= 200),
  commit_sha         text        CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40,64}$'),
  attempts           integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failed_stage       text        CHECK (failed_stage IS NULL OR failed_stage IN ('extract', 'distil', 'validate', 'commit')),
  -- an item waiting for a budget or a busy turn is not picked up before this time
  not_before         timestamptz,
  released_by        uuid        REFERENCES app.actors (id) ON DELETE SET NULL,
  released_at        timestamptz,
  -- the Archivist's drop run that reads this item through `inbox.read` (see app.inbox_run_item)
  drop_run_id        uuid        REFERENCES app.bot_runs (id) ON DELETE SET NULL,
  original_removed_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  filed_at           timestamptz,
  CONSTRAINT memory_inbox_held_has_reason CHECK (state <> 'held' OR hold_reason IS NOT NULL),
  CONSTRAINT memory_inbox_filed_has_commit CHECK (state <> 'filed' OR (commit_sha IS NOT NULL AND filed_at IS NOT NULL))
);
CREATE INDEX memory_inbox_items_team ON app.memory_inbox_items (team_id, id DESC);
CREATE INDEX memory_inbox_items_workspace ON app.memory_inbox_items (workspace_id);
CREATE INDEX memory_inbox_items_sha ON app.memory_inbox_items (team_id, sha256);
CREATE INDEX memory_inbox_items_parent ON app.memory_inbox_items (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX memory_inbox_items_duplicate_of ON app.memory_inbox_items (duplicate_of) WHERE duplicate_of IS NOT NULL;
CREATE INDEX memory_inbox_items_dropper ON app.memory_inbox_items (dropper_id) WHERE dropper_id IS NOT NULL;
CREATE INDEX memory_inbox_items_released_by ON app.memory_inbox_items (released_by) WHERE released_by IS NOT NULL;
CREATE INDEX memory_inbox_items_files ON app.memory_inbox_items (files_id) WHERE files_id IS NOT NULL;
CREATE INDEX memory_inbox_items_run ON app.memory_inbox_items (drop_run_id) WHERE drop_run_id IS NOT NULL;
CREATE INDEX memory_inbox_items_blob ON app.memory_inbox_items (blob_key) WHERE blob_key IS NOT NULL;
-- the sweep looks for items that are waiting or look stuck
CREATE INDEX memory_inbox_items_active ON app.memory_inbox_items (updated_at) WHERE state IN ('queued', 'extracting', 'filing');
COMMENT ON TABLE app.memory_inbox_items IS 'rls: team — T: readable by the people of the team (app.readable_team_ids read; not a guest), a held item only by its dropper and the team''s leads and workspace admins; a person with post rights on the team inserts their own drops; leads and admins release, discard and retry; the pipeline is the system role. `blob_key` points at the original (the files blob GC reads it).';

CREATE TABLE app.memory_inbox_extracts (
  item_id    uuid PRIMARY KEY REFERENCES app.memory_inbox_items (id) ON DELETE CASCADE,
  team_id    uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  -- the bound is a constraint, not only application code: the extractor caps at 900,000 characters
  text       text        NOT NULL CHECK (char_length(text) <= 1000000),
  title      text        CHECK (title IS NULL OR char_length(title) <= 500),
  sections   jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sections) = 'array' AND pg_column_size(sections) <= 200000),
  -- what the Archivist proposed (an array of OkfProposal), and who made it (`archivist/<alias>`); null until the distil step has run
  proposals  jsonb       CHECK (proposals IS NULL OR (jsonb_typeof(proposals) = 'array' AND pg_column_size(proposals) <= 4000000)),
  producer   text        CHECK (producer IS NULL OR char_length(producer) <= 200),
  redacted   boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_inbox_extracts_team ON app.memory_inbox_extracts (team_id);
COMMENT ON TABLE app.memory_inbox_extracts IS 'rls: team — T: the platform''s working copy of an item''s text and proposals; written by the system role only; read and removed by the team''s leads and workspace admins (a discard removes it) and the system; a bot reads one item through app.inbox_run_item.';

-- RLS --------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.memory_inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_inbox_items FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_inbox_items_select ON app.memory_inbox_items FOR SELECT USING (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
      AND (state <> 'held'
           OR dropper_id = (SELECT app.actor())
           OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])))
);
CREATE POLICY memory_inbox_items_insert ON app.memory_inbox_items FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])
      AND dropper_id = (SELECT app.actor())
      AND origin IN ('person', 'message', 'bot')
      AND state IN ('queued', 'duplicate')
      AND stage IN ('hold', 'done')
      AND parent_id IS NULL AND files_id IS NULL AND drop_run_id IS NULL AND filed_paths = '{}')
);
CREATE POLICY memory_inbox_items_update ON app.memory_inbox_items FOR UPDATE
  USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
  WITH CHECK ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]));
CREATE POLICY memory_inbox_items_delete ON app.memory_inbox_items FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.memory_inbox_items TO manythreads_app;

ALTER TABLE app.memory_inbox_extracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_inbox_extracts FORCE ROW LEVEL SECURITY;
-- the platform writes it; a lead or admin who discards an item may read and remove its working copy (they are the people who decide on held items anyway)
CREATE POLICY memory_inbox_extracts_select ON app.memory_inbox_extracts FOR SELECT USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]));
CREATE POLICY memory_inbox_extracts_insert ON app.memory_inbox_extracts FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY memory_inbox_extracts_update ON app.memory_inbox_extracts FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY memory_inbox_extracts_delete ON app.memory_inbox_extracts FOR DELETE USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.memory_inbox_extracts TO manythreads_app;

-- A person who may only manage the team (a lead, an admin) can move an item along, not rewrite it: what a drop IS (its bytes, name, dropper, origin,
-- sender) never changes, and the only moves a non-system caller makes are release (held or needs review → queued), retry (failed → queued) and
-- discard (any waiting state → discarded, which also clears the original). Everything else is the pipeline's, as the system role.
CREATE FUNCTION app.memory_inbox_items_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  NEW.updated_at := now();
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.size IS DISTINCT FROM OLD.size OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.dropper_id IS DISTINCT FROM OLD.dropper_id OR NEW.dropper_name IS DISTINCT FROM OLD.dropper_name
     OR NEW.team_only IS DISTINCT FROM OLD.team_only OR NEW.sender IS DISTINCT FROM OLD.sender OR NEW.sender_check IS DISTINCT FROM OLD.sender_check
     OR NEW.files_id IS DISTINCT FROM OLD.files_id OR NEW.drop_run_id IS DISTINCT FROM OLD.drop_run_id OR NEW.duplicate_of IS DISTINCT FROM OLD.duplicate_of
     OR NEW.filed_paths IS DISTINCT FROM OLD.filed_paths OR NEW.commit_sha IS DISTINCT FROM OLD.commit_sha OR NEW.filed_at IS DISTINCT FROM OLD.filed_at
     OR NEW.source_channel_id IS DISTINCT FROM OLD.source_channel_id OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id THEN
    RAISE EXCEPTION 'Only the platform changes what an inbox item is.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state = 'queued' AND OLD.state IN ('held', 'needs_review', 'failed') THEN
      RETURN NEW;
    END IF;
    IF NEW.state = 'discarded' AND OLD.state IN ('queued', 'held', 'needs_review', 'failed') AND NEW.blob_key IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'An inbox item in state % cannot be moved to %.', OLD.state, NEW.state USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.blob_key IS DISTINCT FROM OLD.blob_key THEN
    RAISE EXCEPTION 'Only the platform removes an original.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.memory_inbox_items_guard() FROM PUBLIC;
CREATE TRIGGER memory_inbox_items_guard BEFORE UPDATE ON app.memory_inbox_items FOR EACH ROW EXECUTE FUNCTION app.memory_inbox_items_guard();

-- The caps are the database's, not only the route's: a drop is the way into the pipeline, so a runaway client (or a loop in a bot) is stopped here too.
-- A lock per team makes inserts take turns; the count runs under the caller's own read policy, which always includes the dropper's own rows.
CREATE FUNCTION app.memory_inbox_items_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.state <> 'queued' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memory_inbox_items:' || NEW.team_id::text, 0));
  IF (SELECT count(*) FROM app.memory_inbox_items WHERE team_id = NEW.team_id AND state IN ('queued', 'extracting', 'filing') AND parent_id IS NULL) >= 500 THEN
    RAISE EXCEPTION 'This team''s inbox already has 500 items waiting; wait for some to be filed.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.memory_inbox_items_cap() FROM PUBLIC;
CREATE TRIGGER memory_inbox_items_cap BEFORE INSERT ON app.memory_inbox_items FOR EACH ROW EXECUTE FUNCTION app.memory_inbox_items_cap();

-- What a `drop` run reads through `inbox.read`: the one item bound to that run, and its text, as data. The tool runs as the bot (so row-level security on the
-- items would show it nothing, and on the extracts shows nobody but the system), which is why this is a definer function. It answers only for `app.run_id()` (set
-- only by the kernel's `withActor`), only while that run is live, is of the `drop` trigger and belongs to the item's own team, and only for an item the platform has
-- bound to that run, still being filed (a held, discarded or finished item is never given). The bot must be the actor of that transaction.
CREATE FUNCTION app.inbox_run_item() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE r record;
BEGIN
  SELECT i.id, i.team_id, i.origin, i.kind, i.name, i.team_only, e.text, e.title
    INTO r
    FROM app.bot_runs br
    JOIN app.actors bot_actor ON bot_actor.kind = 'bot' AND bot_actor.ref_id = br.bot_id AND bot_actor.workspace_id = br.workspace_id
    JOIN app.memory_inbox_items i ON i.drop_run_id = br.id AND i.team_id = br.team_id
    JOIN app.memory_inbox_extracts e ON e.item_id = i.id
   WHERE br.id = app.run_id() AND br.status = 'running' AND br.ended_at IS NULL AND br.trigger_type = 'drop'
     AND app.actor() = bot_actor.id
     AND i.state = 'filing' AND i.stage = 'distil';
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('itemId', r.id, 'teamId', r.team_id, 'origin', r.origin, 'kind', r.kind, 'name', r.name, 'teamOnly', r.team_only, 'title', r.title, 'text', r.text);
END
$$;
REVOKE ALL ON FUNCTION app.inbox_run_item() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.inbox_run_item() TO manythreads_app, manythreads_system;

-- Owned by the system role like every other definer function (a login that can set up the schema would otherwise be the one whose rights these run with).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.inbox_run_item() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
