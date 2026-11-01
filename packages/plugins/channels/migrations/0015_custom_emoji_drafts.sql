-- channels 0015: custom emoji and drafts kept on the server (PLAN P14-02). Forward-only: never edit once applied.
--
--  * custom_emoji: pictures a workspace owner or admin adds, written `:name:` in a message or a reaction. One row per picture, the bytes in the row (at most 256 KiB,
--    png, jpeg, gif or webp; the route checks the first bytes, this table checks the size and the declared type). A name is unique in its workspace. Everyone in the
--    workspace reads the rows (the list, and the picture through a route); only an owner or admin adds or removes one. At most 500 per workspace, also when two requests race.
--    The plan calls this a "workspace-wide global table": it is workspace-wide (one set for every team of the workspace) but it carries `workspace_id` and row-level
--    security like every other tenant table, so it is NOT on the `global_tables` allowlist (that list is pinned to four kernel tables by a test, and a picture of one
--    workspace must never be readable from another).
--  * message_drafts: the text a person typed in a channel's box or a thread's reply box and did not send, so another device shows it. One row per (person, channel,
--    thread); the channel's own box has no thread. PRIVATE TO THE PERSON: only they read, change or delete a row (an admin cannot, the system role is not given a
--    policy because nothing but the person's own requests touches it). Nothing is announced: no event and no push, like a notification level. A person drafts only
--    in a channel they may post in. thread_root_id has no foreign key on purpose: a draft of a thread whose first message vanished is harmless and goes with the channel.
--    At most 200 per person: saving one more removes the one changed longest ago, so an automatic save never fails on the cap.

CREATE TABLE app.custom_emoji (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{1,31}$'),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  bytes        bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 12 AND 262144),
  created_by   uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX custom_emoji_name ON app.custom_emoji (workspace_id, name);
CREATE INDEX custom_emoji_created_by ON app.custom_emoji (created_by) WHERE created_by IS NOT NULL;
COMMENT ON TABLE app.custom_emoji IS 'rls: workspace — W: custom emoji pictures of a workspace; everyone in the workspace reads them, only an owner or admin adds or removes one.';

CREATE FUNCTION app.custom_emoji_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('custom_emoji:' || NEW.workspace_id::text, 0));
  IF (SELECT count(*) FROM app.custom_emoji WHERE workspace_id = NEW.workspace_id) >= 500 THEN
    RAISE EXCEPTION 'This workspace already has 500 custom emoji. Remove some first.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER custom_emoji_cap BEFORE INSERT ON app.custom_emoji FOR EACH ROW EXECUTE FUNCTION app.custom_emoji_cap();

ALTER TABLE app.custom_emoji ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.custom_emoji FORCE ROW LEVEL SECURITY;
CREATE POLICY custom_emoji_select ON app.custom_emoji FOR SELECT
  USING ((SELECT app.is_system()) OR workspace_id = (SELECT app.workspace_id()));
CREATE POLICY custom_emoji_insert ON app.custom_emoji FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY custom_emoji_delete ON app.custom_emoji FOR DELETE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, DELETE ON app.custom_emoji TO manythreads_app;

-- message_drafts -------------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.message_drafts (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  person_id      uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  channel_id     uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  thread_root_id uuid,
  -- the unique key of (person, channel, thread): the channel's own box counts as the nil thread, so one row exists for it too
  thread_key     uuid GENERATED ALWAYS AS (coalesce(thread_root_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 40000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX message_drafts_slot ON app.message_drafts (person_id, channel_id, thread_key);
CREATE INDEX message_drafts_channel ON app.message_drafts (channel_id);
CREATE INDEX message_drafts_workspace ON app.message_drafts (workspace_id);
CREATE INDEX message_drafts_recent ON app.message_drafts (person_id, updated_at);
COMMENT ON TABLE app.message_drafts IS 'rls: person — P: the text a person typed in a channel box or a thread reply box and did not send; only that person reads, changes or deletes a row, and drafts only in a channel they may post in.';

-- At most 200 per person, also when two saves race: a person's inserts take turns on an advisory lock; the one over the cap pushes out the oldest change.
CREATE FUNCTION app.message_drafts_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('message_drafts:' || NEW.person_id::text, 0));
  -- an insert that will turn into an update of the same slot (ON CONFLICT) adds no row, so it pushes nothing out (a generated column is not computed yet in a BEFORE trigger)
  IF EXISTS (SELECT 1 FROM app.message_drafts d WHERE d.person_id = NEW.person_id AND d.channel_id = NEW.channel_id
                AND d.thread_key = coalesce(NEW.thread_root_id, '00000000-0000-0000-0000-000000000000'::uuid)) THEN
    RETURN NEW;
  END IF;
  DELETE FROM app.message_drafts
   WHERE id IN (SELECT id FROM app.message_drafts WHERE person_id = NEW.person_id ORDER BY updated_at DESC, id DESC OFFSET 199);
  RETURN NEW;
END
$$;
CREATE TRIGGER message_drafts_cap BEFORE INSERT ON app.message_drafts FOR EACH ROW EXECUTE FUNCTION app.message_drafts_cap();

ALTER TABLE app.message_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.message_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY message_drafts_select ON app.message_drafts FOR SELECT
  USING (person_id = (SELECT app.person_id()));
CREATE POLICY message_drafts_insert ON app.message_drafts FOR INSERT WITH CHECK (
  person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())
  AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]));
CREATE POLICY message_drafts_update ON app.message_drafts FOR UPDATE
  USING (person_id = (SELECT app.person_id()))
  WITH CHECK (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())
              AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]));
CREATE POLICY message_drafts_delete ON app.message_drafts FOR DELETE
  USING (person_id = (SELECT app.person_id()));
GRANT SELECT, INSERT, DELETE ON app.message_drafts TO manythreads_app;
-- a draft's owner, place and slot never change: an edit changes the text (and the time of the change) only
GRANT UPDATE (body, updated_at) ON app.message_drafts TO manythreads_app;
