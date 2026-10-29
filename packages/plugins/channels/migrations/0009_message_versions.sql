-- channels 0009: earlier versions of an edited message (PLAN P14-12). Forward-only: never edit once applied.
--
-- When a message's text changes, the text it had is kept here: who may read the message may read its earlier versions (the same hoisted
-- visibility set as the message), and nobody writes a row but the trigger below. Deleting a message drops its versions in the same
-- statement (the row of the message stays as a tombstone, its history does not). The newest 50 versions of one message are kept: a bot that
-- rewrites one checklist message every minute must not grow the table without bound.
--
-- Nothing else reads this table: search and memory index `messages.body_plain`, never a version, and retention (runs, memory log) does not touch messages.

CREATE TABLE app.message_versions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  message_id  uuid NOT NULL REFERENCES app.messages (id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL,          -- copied from the message by the trigger so the policy can probe the visibility set
  body        text NOT NULL,
  written_at  timestamptz NOT NULL,   -- when this text was written (the message's creation, or the edit before)
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_versions_message ON app.message_versions (message_id, id);
COMMENT ON TABLE app.message_versions IS 'rls: team — C: earlier texts of an edited message; readable with the message (app.visible_channel_ids), written only by the messages trigger, dropped when the message is deleted.';

ALTER TABLE app.message_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.message_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY message_versions_select ON app.message_versions FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
-- Written by the trigger function below (definer, owned by manythreads_system) and by system code, never by a caller.
CREATE POLICY message_versions_system ON app.message_versions FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.message_versions TO manythreads_app;

-- Keep the old text when it changes; drop every version when the message is deleted.
CREATE FUNCTION app.messages_keep_version() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM app.message_versions WHERE message_id = NEW.id;
    RETURN NEW;
  END IF;
  IF OLD.body IS DISTINCT FROM NEW.body THEN
    INSERT INTO app.message_versions (message_id, channel_id, body, written_at, replaced_at)
    VALUES (OLD.id, OLD.channel_id, OLD.body, coalesce(OLD.edited_at, OLD.created_at), coalesce(NEW.edited_at, now()));
    DELETE FROM app.message_versions v
     WHERE v.message_id = OLD.id
       AND v.id NOT IN (SELECT k.id FROM app.message_versions k WHERE k.message_id = OLD.id ORDER BY k.id DESC LIMIT 50);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER messages_keep_version AFTER UPDATE OF body, deleted_at ON app.messages FOR EACH ROW
  WHEN (OLD.body IS DISTINCT FROM NEW.body OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL))
  EXECUTE FUNCTION app.messages_keep_version();

-- The author takes the earlier versions of their own message away (a secret pasted by mistake and then edited out would otherwise stay in
-- the history). Returns how many were removed; 0 for anyone else, a message the caller cannot read, or a deleted message. Inside a definer
-- function app.is_system() is true, so the caller is checked with app.actor() and the visibility set, never with a policy.
CREATE FUNCTION app.message_versions_clear(p_message_id uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_channel uuid;
  v_author  uuid;
  v_n       integer;
BEGIN
  SELECT m.channel_id, m.author_id INTO v_channel, v_author FROM app.messages m WHERE m.id = p_message_id AND m.workspace_id = app.workspace_id();
  IF v_channel IS NULL OR NOT (v_channel = ANY (app.visible_channel_ids('read'))) OR v_author IS DISTINCT FROM app.actor() THEN
    RETURN 0;
  END IF;
  DELETE FROM app.message_versions WHERE message_id = p_message_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION app.message_versions_clear(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.message_versions_clear(uuid) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.messages_keep_version() OWNER TO manythreads_system;
ALTER FUNCTION app.message_versions_clear(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
