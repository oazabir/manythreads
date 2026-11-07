-- memory-inbox 0004: a person's own inbox (P20-04, D10). Forward-only: never edit once applied.
--
-- A place to drop a file, a note or a link that only its owner sees. The platform reads it into text and files a Reference in the person's own Memory (a Personal space:
-- rows, never git). The team inbox is bound to a team at every step (its holds, its size cap, its two-at-a-time turn), so the personal inbox is a table of its own with a
-- shorter road: receive, hold check, read, file. There is no Archivist step; the Reference holds the text, and a person who wants it in a team uses "Send to team".
--
--  * memory_personal_inbox_items: one row per drop. `owner_person_id` is the only owner: the policies below read it, never a team. `blob_key` points at the original in
--                                 blob storage (the files blob GC reads it, like the team inbox's); it is cleared when a discard removes the original.

CREATE TABLE app.memory_personal_inbox_items (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  owner_person_id     uuid        NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  origin              text        NOT NULL CHECK (origin IN ('person', 'message')),
  state               text        NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'extracting', 'filing', 'filed', 'held', 'failed', 'duplicate', 'discarded')),
  stage               text        NOT NULL DEFAULT 'hold' CHECK (stage IN ('hold', 'extract', 'done')),
  kind                text        NOT NULL CHECK (kind IN ('markdown', 'text', 'csv', 'pdf', 'docx', 'pptx', 'xlsx', 'eml', 'html', 'image', 'audio', 'video', 'link', 'bundle', 'unknown')),
  name                text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  size                bigint      NOT NULL CHECK (size >= 0),
  sha256              text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  blob_key            text        CHECK (blob_key IS NULL OR char_length(blob_key) BETWEEN 1 AND 128),
  -- the owner's actor when it was dropped, and the owner's name (the list cannot join to `people`)
  dropper_id          uuid        REFERENCES app.actors (id) ON DELETE SET NULL,
  dropper_name        text        CHECK (dropper_name IS NULL OR char_length(dropper_name) <= 200),
  reason              text        CHECK (reason IS NULL OR char_length(reason) <= 400),
  hold_reason         text        CHECK (hold_reason IS NULL OR hold_reason IN ('foreign_bundle', 'dlp', 'oversize')),
  duplicate_of        uuid        REFERENCES app.memory_personal_inbox_items (id) ON DELETE SET NULL,
  -- where a "send to memory" message came from: provenance only, no key (the message may be deleted later)
  source_channel_id   uuid,
  source_message_id   uuid,
  filed_paths         text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(filed_paths) <= 20),
  attempts            integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failed_stage        text        CHECK (failed_stage IS NULL OR failed_stage IN ('extract', 'commit')),
  released_at         timestamptz,
  original_removed_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  filed_at            timestamptz,
  CONSTRAINT memory_personal_inbox_held_has_reason CHECK (state <> 'held' OR hold_reason IS NOT NULL),
  CONSTRAINT memory_personal_inbox_filed_has_time CHECK (state <> 'filed' OR filed_at IS NOT NULL)
);
CREATE INDEX memory_personal_inbox_owner ON app.memory_personal_inbox_items (owner_person_id, id DESC);
CREATE INDEX memory_personal_inbox_workspace ON app.memory_personal_inbox_items (workspace_id);
CREATE INDEX memory_personal_inbox_sha ON app.memory_personal_inbox_items (owner_person_id, sha256);
CREATE INDEX memory_personal_inbox_duplicate_of ON app.memory_personal_inbox_items (duplicate_of) WHERE duplicate_of IS NOT NULL;
CREATE INDEX memory_personal_inbox_dropper ON app.memory_personal_inbox_items (dropper_id) WHERE dropper_id IS NOT NULL;
CREATE INDEX memory_personal_inbox_blob ON app.memory_personal_inbox_items (blob_key) WHERE blob_key IS NOT NULL;
-- the sweep looks for items that are waiting or look stuck
CREATE INDEX memory_personal_inbox_active ON app.memory_personal_inbox_items (updated_at) WHERE state IN ('queued', 'extracting', 'filing');
COMMENT ON TABLE app.memory_personal_inbox_items IS 'rls: person — P: a person''s own inbox; readable by the owner, by an admin during a live audited open of the space, and by the system; the owner inserts their own drops and releases, discards and retries them; the pipeline is the system role. `blob_key` points at the original (the files blob GC reads it).';

ALTER TABLE app.memory_personal_inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_personal_inbox_items FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_personal_inbox_select ON app.memory_personal_inbox_items FOR SELECT USING (
  (SELECT app.is_system())
  OR owner_person_id = ANY ((SELECT app.readable_space_ids('read'))::uuid[])
);
-- Only the owner themself drops: an admin's open of the space is read-only, and a bot never drops into a person's inbox.
CREATE POLICY memory_personal_inbox_insert ON app.memory_personal_inbox_items FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (owner_person_id = (SELECT app.person_id())
      AND dropper_id = (SELECT app.actor())
      AND origin IN ('person', 'message')
      AND state IN ('queued', 'duplicate')
      AND stage IN ('hold', 'done')
      AND filed_paths = '{}' AND released_at IS NULL)
);
CREATE POLICY memory_personal_inbox_update ON app.memory_personal_inbox_items FOR UPDATE
  USING ((SELECT app.is_system()) OR owner_person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system()) OR owner_person_id = (SELECT app.person_id()));
CREATE POLICY memory_personal_inbox_delete ON app.memory_personal_inbox_items FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.memory_personal_inbox_items TO manythreads_app;

-- The owner moves an item along; she does not rewrite it. What a drop IS (its bytes, name, owner, origin, source) never changes, and the only moves a non-system
-- caller makes are release (held -> queued), retry (failed -> queued) and discard (a waiting state -> discarded, which clears the original). Everything else is the
-- pipeline's, as the system role.
CREATE FUNCTION app.memory_personal_inbox_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  NEW.updated_at := now();
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id
     OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.size IS DISTINCT FROM OLD.size OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.dropper_id IS DISTINCT FROM OLD.dropper_id
     OR NEW.dropper_name IS DISTINCT FROM OLD.dropper_name OR NEW.duplicate_of IS DISTINCT FROM OLD.duplicate_of
     OR NEW.filed_paths IS DISTINCT FROM OLD.filed_paths OR NEW.filed_at IS DISTINCT FROM OLD.filed_at
     OR NEW.source_channel_id IS DISTINCT FROM OLD.source_channel_id OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id THEN
    RAISE EXCEPTION 'Only the platform changes what an inbox item is.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state = 'queued' AND OLD.state IN ('held', 'failed') THEN
      RETURN NEW;
    END IF;
    IF NEW.state = 'discarded' AND OLD.state IN ('queued', 'held', 'failed') AND NEW.blob_key IS NULL THEN
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
REVOKE ALL ON FUNCTION app.memory_personal_inbox_guard() FROM PUBLIC;
CREATE TRIGGER memory_personal_inbox_guard BEFORE UPDATE ON app.memory_personal_inbox_items FOR EACH ROW EXECUTE FUNCTION app.memory_personal_inbox_guard();

-- The caps are the database's, not only the route's: a runaway client is stopped here too. A lock per person makes inserts take turns; the count runs under the
-- caller's own read policy, which always includes the owner's own rows.
CREATE FUNCTION app.memory_personal_inbox_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.state <> 'queued' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memory_personal_inbox:' || NEW.owner_person_id::text, 0));
  IF (SELECT count(*) FROM app.memory_personal_inbox_items WHERE owner_person_id = NEW.owner_person_id AND state IN ('queued', 'extracting', 'filing')) >= 200 THEN
    RAISE EXCEPTION 'Your inbox already has 200 items waiting; wait for some to be filed.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.memory_personal_inbox_cap() FROM PUBLIC;
CREATE TRIGGER memory_personal_inbox_cap BEFORE INSERT ON app.memory_personal_inbox_items FOR EACH ROW EXECUTE FUNCTION app.memory_personal_inbox_cap();
