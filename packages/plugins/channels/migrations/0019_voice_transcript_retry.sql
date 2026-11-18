-- channels 0019: asking for a voice message's transcript again (P32-04, decision D13). Forward-only: never edit once applied.
--
-- When the server could not write a transcript, the message says `failed` and, for a failure that may pass (the speech model was busy or did not answer),
-- offers "Try again" to its author (`meta.voice.transcriptRetry` is true). The guard on `messages` (0002, 0017) refuses a caller's change of `meta`, so the
-- one change this needs, `failed` back to `pending`, goes through this narrow function. Inside a definer function app.is_system() is true, so the caller
-- is checked here with app.actor() and the visibility set, never with a policy: only the author, only a live message, only from `failed` with a retry
-- on offer, only in a channel the author may still post in. Answers false for anything else (the route turns that into a 409). The text and the edit time
-- are not touched.
CREATE FUNCTION app.voice_transcript_retry(p_message_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_channel uuid;
  v_author  uuid;
BEGIN
  SELECT m.channel_id, m.author_id INTO v_channel, v_author
    FROM app.messages m
   WHERE m.id = p_message_id AND m.workspace_id = app.workspace_id() AND m.deleted_at IS NULL
     AND m.meta -> 'voice' ->> 'transcript' = 'failed' AND m.meta -> 'voice' ->> 'transcriptRetry' = 'true';
  IF v_channel IS NULL OR v_author IS DISTINCT FROM app.actor() OR NOT (v_channel = ANY (app.visible_channel_ids('post'))) THEN
    RETURN false;
  END IF;
  UPDATE app.messages SET meta = jsonb_set(meta, '{voice}', (meta -> 'voice') - 'transcriptNote' - 'transcriptRetry' - 'transcriptEndMs' || '{"transcript": "pending"}'::jsonb)
   WHERE id = p_message_id;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.voice_transcript_retry(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.voice_transcript_retry(uuid) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.voice_transcript_retry(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
