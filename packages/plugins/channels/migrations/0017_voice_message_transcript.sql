-- channels 0017: editing the text of a voice message marks its transcript as edited (PLAN P14-17). Forward-only: never edit once applied.
--
-- A voice message keeps `meta.voice` (the clip, its length, language, loudness bars and where its text came from); the body is the transcript.
-- When the author edits that text, `meta.voice.transcript` becomes 'edited'. The guard of 0002 refuses any change of `meta` by a caller, so it
-- now allows exactly that one change, and only together with an edit of the text by its author: `meta` after the update must equal `meta`
-- before it with `voice.transcript` set to "edited". Every other change of `meta` is still the system's alone.
CREATE OR REPLACE FUNCTION app.messages_before_update() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.channel_id <> OLD.channel_id OR NEW.author_id <> OLD.author_id
     OR NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a message keeps its channel, author, thread and time' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.meta IS DISTINCT FROM OLD.meta THEN
    IF NOT (OLD.meta ? 'voice' AND NEW.body IS DISTINCT FROM OLD.body
            AND NEW.meta IS NOT DISTINCT FROM jsonb_set(OLD.meta, '{voice,transcript}', '"edited"')) THEN
      RAISE EXCEPTION 'a message keeps its channel, author, thread and time' USING ERRCODE = 'insufficient_privilege';
    END IF;
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
