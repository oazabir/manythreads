-- channels 0002: messages, reactions, mentions, threads, thread_follows (PLAN.md A.3, P3-02). Forward-only: never edit once applied.
--
-- Every read policy probes the hoisted visibility set of 0001 (`channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])`);
-- the plan of `SELECT count(*) FROM app.messages` as manythreads_app holds no per-row app.can call (pnpm test:rls checks it).
-- Writes are single-row decisions: an INSERT checks the 'post' set, an UPDATE the author or a team lead, and triggers (definer,
-- owned by the system role) keep what no caller may write: the thread row, the channel id copied onto a reaction or mention.

-- messages (C) -------------------------------------------------------------------------------------------------------------
CREATE TABLE app.messages (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL,
  channel_id     uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  author_id      uuid NOT NULL REFERENCES app.actors (id),
  body           text NOT NULL CHECK (length(body) BETWEEN 1 AND 40000),   -- markdown
  body_plain     text NOT NULL,                                            -- derived by the server; '' once deleted
  thread_root_id uuid REFERENCES app.messages (id) ON DELETE CASCADE,
  edited_at      timestamptz,
  deleted_at     timestamptz,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_not_own_root CHECK (thread_root_id IS NULL OR thread_root_id <> id)
);
CREATE INDEX messages_channel_id_desc ON app.messages (channel_id, id DESC) INCLUDE (author_id, thread_root_id);
CREATE INDEX messages_thread ON app.messages (thread_root_id, id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX messages_body_plain_trgm ON app.messages USING gin (body_plain gin_trgm_ops);
CREATE INDEX messages_author ON app.messages (author_id);
COMMENT ON TABLE app.messages IS 'rls: team — C: messages of the channels the caller can read (app.visible_channel_ids); post needs the post set, edit the author, delete the author or a team lead.';

-- message_reactions (C) ----------------------------------------------------------------------------------------------------
CREATE TABLE app.message_reactions (
  message_id uuid NOT NULL REFERENCES app.messages (id) ON DELETE CASCADE,
  actor_id   uuid NOT NULL,
  emoji      text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 64),
  channel_id uuid NOT NULL,          -- copied from the message by a trigger so the policy can probe the visibility set
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, actor_id, emoji)
);
COMMENT ON TABLE app.message_reactions IS 'rls: team — C: emoji reactions; readable with the message, an actor adds and removes only their own.';

-- message_mentions (C) -----------------------------------------------------------------------------------------------------
CREATE TABLE app.message_mentions (
  message_id   uuid NOT NULL REFERENCES app.messages (id) ON DELETE CASCADE,
  mentioned_id uuid NOT NULL,        -- a person or bot actor id, or a channel id (kind)
  kind         text NOT NULL CHECK (kind IN ('person', 'bot', 'channel')),
  channel_id   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, mentioned_id, kind)
);
CREATE INDEX message_mentions_mentioned ON app.message_mentions (mentioned_id, message_id DESC);
COMMENT ON TABLE app.message_mentions IS 'rls: team — C: mentions parsed from a message; readable with the message, written by its author.';

-- threads (C) --------------------------------------------------------------------------------------------------------------
CREATE TABLE app.threads (
  root_message_id uuid PRIMARY KEY REFERENCES app.messages (id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  title           text NOT NULL DEFAULT '',
  reply_count     integer NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  last_reply_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX threads_channel_last_reply ON app.threads (channel_id, last_reply_at DESC);
CREATE INDEX threads_title_trgm ON app.threads USING gin (title gin_trgm_ops);
COMMENT ON TABLE app.threads IS 'rls: team — C: one row per root message, created and counted by the messages triggers; readable with the channel.';

-- thread_follows (P) -------------------------------------------------------------------------------------------------------
CREATE TABLE app.thread_follows (
  person_id      uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  thread_root_id uuid NOT NULL REFERENCES app.messages (id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, thread_root_id)
);
CREATE INDEX thread_follows_root ON app.thread_follows (thread_root_id);
COMMENT ON TABLE app.thread_follows IS 'rls: person — P: the threads a person follows; own rows only, and only for a thread whose message they can read.';

-- Triggers (definer, owned by manythreads_system: they read and write rows the caller may not) -------------------------------------
-- A new message belongs to its channel's workspace; a reply goes to a root message of the same channel that is itself a root.
CREATE FUNCTION app.messages_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws   uuid;
  r      app.messages;
BEGIN
  SELECT c.workspace_id INTO v_ws FROM app.channels c WHERE c.id = NEW.channel_id;
  IF v_ws IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'a message belongs to its channel''s workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.thread_root_id IS NOT NULL THEN
    SELECT * INTO r FROM app.messages m WHERE m.id = NEW.thread_root_id;
    IF NOT FOUND OR r.channel_id <> NEW.channel_id OR r.thread_root_id IS NOT NULL THEN
      RAISE EXCEPTION 'a reply goes to a message of the same channel that is not itself a reply' USING ERRCODE = 'check_violation';
    END IF;
    IF r.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'you cannot reply to a deleted message' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER messages_before_insert BEFORE INSERT ON app.messages FOR EACH ROW EXECUTE FUNCTION app.messages_before_insert();

-- The first reply creates the thread row; every reply counts, in the same statement, so reply_count and last_reply_at never lag.
CREATE FUNCTION app.messages_after_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  INSERT INTO app.threads (root_message_id, channel_id, title, reply_count, last_reply_at)
  SELECT m.id, m.channel_id, left(m.body_plain, 120), 1, NEW.created_at FROM app.messages m WHERE m.id = NEW.thread_root_id
  ON CONFLICT (root_message_id) DO UPDATE
    SET reply_count = app.threads.reply_count + 1, last_reply_at = greatest(app.threads.last_reply_at, EXCLUDED.last_reply_at);
  RETURN NEW;
END
$$;
CREATE TRIGGER messages_after_insert AFTER INSERT ON app.messages FOR EACH ROW
  WHEN (NEW.thread_root_id IS NOT NULL) EXECUTE FUNCTION app.messages_after_insert();

-- Deleting a reply takes it out of the count.
CREATE FUNCTION app.messages_after_delete_mark() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.threads SET reply_count = greatest(reply_count - 1, 0) WHERE root_message_id = NEW.thread_root_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER messages_after_delete_mark AFTER UPDATE OF deleted_at ON app.messages FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.thread_root_id IS NOT NULL)
  EXECUTE FUNCTION app.messages_after_delete_mark();

-- What a caller may change on a message: text (the author, not once deleted) and the deletion mark (set once, never undone,
-- the text then leaves search). Everything else is the system's. (Who may do either is the UPDATE policies' business.)
CREATE FUNCTION app.messages_before_update() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.channel_id <> OLD.channel_id OR NEW.author_id <> OLD.author_id
     OR NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id OR NEW.created_at <> OLD.created_at OR NEW.meta IS DISTINCT FROM OLD.meta THEN
    RAISE EXCEPTION 'a message keeps its channel, author, thread and time' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    IF OLD.author_id <> app.actor() OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.edited_at IS NULL THEN
      RAISE EXCEPTION 'only the author edits a message, and not a deleted one' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.body_plain <> '' THEN
      RAISE EXCEPTION 'a message is deleted once, and its text then leaves search' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.body_plain IS DISTINCT FROM OLD.body_plain OR NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
    RAISE EXCEPTION 'search text and edit time change only with the text' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER messages_before_update BEFORE UPDATE ON app.messages FOR EACH ROW EXECUTE FUNCTION app.messages_before_update();

-- A reaction or mention takes its channel from the message (a caller cannot claim another channel's visibility); a mention is
-- written by the message's author.
CREATE FUNCTION app.message_children_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_channel uuid;
  v_author  uuid;
BEGIN
  SELECT m.channel_id, m.author_id INTO v_channel, v_author FROM app.messages m WHERE m.id = NEW.message_id;
  IF v_channel IS NULL THEN
    RAISE EXCEPTION 'no such message' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_TABLE_NAME = 'message_mentions' AND session_user <> 'manythreads_system' AND v_author IS DISTINCT FROM app.actor() THEN
    RAISE EXCEPTION 'only the author of a message writes its mentions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.channel_id := v_channel;
  RETURN NEW;
END
$$;
CREATE TRIGGER message_reactions_before_insert BEFORE INSERT ON app.message_reactions FOR EACH ROW EXECUTE FUNCTION app.message_children_before_insert();
CREATE TRIGGER message_mentions_before_insert BEFORE INSERT ON app.message_mentions FOR EACH ROW EXECUTE FUNCTION app.message_children_before_insert();

-- Row level security ---------------------------------------------------------------------------------------------------------------
ALTER TABLE app.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.messages FORCE ROW LEVEL SECURITY;
CREATE POLICY messages_select ON app.messages FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY messages_insert ON app.messages FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (
    workspace_id = (SELECT app.workspace_id()) AND author_id = (SELECT app.actor())
    AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])));
CREATE POLICY messages_update_own ON app.messages FOR UPDATE
  USING ((SELECT app.is_system()) OR (author_id = (SELECT app.actor()) AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])))
  WITH CHECK ((SELECT app.is_system()) OR (author_id = (SELECT app.actor()) AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])));
CREATE POLICY messages_update_lead ON app.messages FOR UPDATE
  USING (app.channel_can(channel_id, 'manage')) WITH CHECK (app.channel_can(channel_id, 'manage'));

ALTER TABLE app.message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.message_reactions FORCE ROW LEVEL SECURITY;
CREATE POLICY message_reactions_select ON app.message_reactions FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY message_reactions_insert ON app.message_reactions FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (actor_id = (SELECT app.actor()) AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])));
CREATE POLICY message_reactions_delete ON app.message_reactions FOR DELETE
  USING ((SELECT app.is_system()) OR actor_id = (SELECT app.actor()));

ALTER TABLE app.message_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.message_mentions FORCE ROW LEVEL SECURITY;
CREATE POLICY message_mentions_select ON app.message_mentions FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY message_mentions_insert ON app.message_mentions FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]));

ALTER TABLE app.threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.threads FORCE ROW LEVEL SECURITY;
CREATE POLICY threads_select ON app.threads FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));

-- Written by the messages triggers (definer functions owned by manythreads_system) and by system code, never by a caller.
CREATE POLICY threads_system ON app.threads FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

ALTER TABLE app.thread_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.thread_follows FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_follows_select ON app.thread_follows FOR SELECT
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
-- Following needs a root message the caller can read (the messages policy filters that lookup).
CREATE POLICY thread_follows_insert ON app.thread_follows FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (
    person_id = (SELECT app.person_id()) AND EXISTS (SELECT 1 FROM app.messages m WHERE m.id = thread_root_id)));
CREATE POLICY thread_follows_delete ON app.thread_follows FOR DELETE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));

-- Privileges -----------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON app.messages TO manythreads_app;
GRANT SELECT, INSERT, DELETE ON app.message_reactions TO manythreads_app;
GRANT SELECT, INSERT ON app.message_mentions TO manythreads_app;
GRANT SELECT ON app.threads TO manythreads_app;
GRANT SELECT, INSERT, DELETE ON app.thread_follows TO manythreads_app;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.messages_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.messages_after_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.messages_after_delete_mark() OWNER TO manythreads_system;
ALTER FUNCTION app.message_children_before_insert() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
