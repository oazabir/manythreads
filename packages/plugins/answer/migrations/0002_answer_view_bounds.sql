-- answer 0002: two bounds on `app.answer_view` that the delta review of 0001 asked for (PLAN P5-18). Forward-only: 0001 was deployed and is never
-- edited; both functions are replaced here with the same signature, the same SECURITY mode and search_path, the same grants and the same owner.
--
--   1. A cited THREAD counted as reached when one of its replies was in the run's log. That was `EXISTS (SELECT 1 FROM app.messages x WHERE
--      x.thread_root_id = <thread> AND 'message:' || x.id::text = ANY (<the log>))`: for every thread citation, every reply of the thread
--      against every line of the log (thread length x 20,000), inside the run's advisory lock. The message ids of the log are now taken out of
--      it once, as a uuid array, and a reply is found by its primary key (`x.id = ANY (<ids>)`): one index probe per logged message.
--   2. `app.answer_run_sources()` returned every reference at full length, so a run that logged 20,000 sources of a megabyte each held 20 GB in
--      the function's result set before the caller cut it to 1,100 characters. The cut is made inside the function: no reference is longer than
--      anything a citation can be (a path is at most 1,024 characters, an id 36), so a longer one can equal none and only its first 1,100
--      characters are ever compared.

CREATE OR REPLACE FUNCTION app.answer_run_sources() RETURNS TABLE (seq integer, source_type text, source_ref text, scope text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT l.seq, l.source_type, left(l.source_ref, 1100), l.scope
    FROM app.run_source_log l
    JOIN app.bot_runs r ON r.id = l.run_id
    JOIN app.actors bot ON bot.kind = 'bot' AND bot.ref_id = r.bot_id AND bot.workspace_id = r.workspace_id
   WHERE l.run_id = app.run_id()
     AND r.status = 'running' AND r.ended_at IS NULL
     AND (app.actor() = bot.id OR (r.asker_id IS NOT NULL AND app.actor() = r.asker_id))
   ORDER BY l.seq
   LIMIT 20001
$$;

CREATE OR REPLACE FUNCTION app.answer_view(p_cites jsonb, p_slugs text[]) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_run       uuid := app.run_id();
  v_self      uuid := app.actor();
  v_actor_was text := current_setting('app.actor_id', true);
  v_kind_was  text := current_setting('app.actor_kind', true);
  v_uuid_re   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  r           record;
  v_prior     uuid;
  v_person    uuid;
  v_name      text;
  v_bot_name  text;
  v_bot_slug  text;
  v_alias     text;
  v_priv      boolean := false;
  v_reach     text;
  v_log       text[];
  v_log_msgs  uuid[];
  v_trunc     boolean := false;
  v_id        uuid;
  v_team      uuid;
  v_reached   boolean;
  v_cites     jsonb := '[]'::jsonb;
  v_sources   jsonb := '[]'::jsonb;
  v_bots      jsonb := '[]'::jsonb;
  c           record;
  s           record;
  v_res       jsonb;
BEGIN
  IF v_run IS NULL OR v_self IS NULL THEN
    RETURN NULL;
  END IF;
  -- the caller's own live run (a bot reads its own run, bots 0011), and the caller is that run's bot
  SELECT br.id, br.bot_id, br.team_id, br.workspace_id, br.trigger_type, br.asker_id, br.channel_id, br.reply_root_id, br.status, br.ended_at
    INTO r FROM app.bot_runs br WHERE br.id = v_run;
  IF NOT FOUND OR r.status <> 'running' OR r.ended_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.actors a WHERE a.id = v_self AND a.kind = 'bot' AND a.ref_id = r.bot_id) THEN
    RETURN NULL;
  END IF;

  -- one answer per run. Check-then-act needs a lock: without it two parallel calls both see "no answer yet" and both post. The lock is the run's
  -- and is held to the end of the transaction, i.e. until the message this call goes on to post is committed.
  PERFORM pg_advisory_xact_lock(hashtextextended('answer:' || v_run::text, 0));
  IF r.channel_id IS NOT NULL AND r.reply_root_id IS NOT NULL THEN
    SELECT x.id INTO v_prior FROM app.messages x
     WHERE x.channel_id = r.channel_id AND x.thread_root_id = r.reply_root_id AND x.author_id = v_self
       AND x.meta ? 'answer' AND x.meta ->> 'runId' = v_run::text AND x.deleted_at IS NULL
     LIMIT 1;
    IF v_prior IS NOT NULL THEN
      RETURN jsonb_build_object('already', v_prior);
    END IF;
  END IF;

  -- what only the bot's own identity can ask: the run's log, and who can read the reply channel
  v_reach := coalesce(app.answer_reply_reach(), 'none');
  v_priv := v_reach = 'asker';
  -- The log is read up to 20,000 lines (each reference is cut to 1,100 characters inside `answer_run_sources`). A run with more is marked
  -- `logTruncated`: what it read after the cap is not in the log this function sees, so it is reported as not reached (docs/plugins/answer.md).
  SELECT coalesce(array_agg(x.ref) FILTER (WHERE x.n <= 20000), '{}'::text[]), coalesce(max(x.n), 0) > 20000 INTO v_log, v_trunc
    FROM (SELECT l.source_type || ':' || l.source_ref AS ref, row_number() OVER (ORDER BY l.seq) AS n FROM app.answer_run_sources() l) x;
  -- the messages the log names, once: a thread citation is "reached" by one of its replies, and that is a primary-key probe per logged message
  -- rather than a comparison of every reply with every line (a ref that is not a uuid names no message)
  SELECT coalesce(array_agg(DISTINCT substr(g.ref, 9)::uuid), '{}'::uuid[]) INTO v_log_msgs
    FROM unnest(v_log) AS g(ref)
   WHERE g.ref LIKE 'message:%' AND substr(g.ref, 9) ~* v_uuid_re;

  -- From here on the asker's own view: the same identity `ctx.runs.asReader` gives a read tool. A run nobody asked reads as its bot. The
  -- switched part is a block of its own: an error inside it rolls the block back, identity switch included, before it leaves.
  BEGIN
    IF r.asker_id IS NOT NULL THEN
      PERFORM set_config('app.actor_id', r.asker_id::text, true);
      PERFORM set_config('app.actor_kind', 'person', true);
      SELECT p.id, p.display_name INTO v_person, v_name
        FROM app.actors a JOIN app.people p ON p.id = a.ref_id
       WHERE a.id = r.asker_id AND a.kind = 'person';
    END IF;
    SELECT b.name, b.slug, b.model_aliases[1] INTO v_bot_name, v_bot_slug, v_alias FROM app.bots b WHERE b.id = r.bot_id;

    FOR c IN
      SELECT j.ord, j.value ->> 'kind' AS kind, j.value ->> 'ref' AS ref, nullif(j.value ->> 'team', '') AS team
        FROM jsonb_array_elements(coalesce(p_cites, '[]'::jsonb)) WITH ORDINALITY AS j(value, ord)
       ORDER BY j.ord
       LIMIT 40
    LOOP
      v_id := CASE WHEN c.ref ~* v_uuid_re THEN c.ref::uuid END;
      v_team := CASE WHEN c.team ~* v_uuid_re THEN c.team::uuid END;
      v_reached := false;
      IF c.kind = 'message' AND v_id IS NOT NULL THEN
        v_reached := ('message:' || lower(c.ref)) = ANY (v_log)
          OR v_id = r.reply_root_id
          OR (r.reply_root_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.messages x WHERE x.id = v_id AND x.thread_root_id = r.reply_root_id));
      ELSIF c.kind = 'thread' AND v_id IS NOT NULL THEN
        v_reached := ('thread:' || lower(c.ref)) = ANY (v_log) OR v_id = ANY (v_log_msgs)
          OR v_id = r.reply_root_id
          OR EXISTS (SELECT 1 FROM app.messages x WHERE x.id = ANY (v_log_msgs) AND x.thread_root_id = v_id);
      ELSIF c.kind = 'file' AND v_id IS NOT NULL THEN
        v_reached := ('file:' || lower(c.ref)) = ANY (v_log);
      ELSIF c.kind = 'run' AND v_id IS NOT NULL THEN
        v_reached := ('run:' || lower(c.ref)) = ANY (v_log) OR v_id = v_run;
      ELSIF c.kind = 'page' AND c.ref IS NOT NULL THEN
        -- the log names a page of the run's team by its path, a page of another team as `<team id>:<path>`
        v_reached := CASE
          WHEN v_team IS NULL OR v_team = r.team_id THEN ('page:' || c.ref) = ANY (v_log) OR ('page:' || r.team_id::text || ':' || c.ref) = ANY (v_log)
          ELSE ('page:' || v_team::text || ':' || c.ref) = ANY (v_log) END;
      END IF;
      IF v_reached THEN
        v_res := app.answer_resolve(c.kind, c.ref, v_team, r.team_id, r.channel_id, v_reach) || jsonb_build_object('reached', true);
      ELSE
        v_res := jsonb_build_object('found', false, 'reached', false);
      END IF;
      v_cites := v_cites || jsonb_build_array(v_res);
    END LOOP;

    -- what the run read: one entry per distinct source, in the order it was reached. A message or a file is resolved like a citation (so a
    -- source the asker can no longer read, or the reply's readers cannot, is out of scope too); anything else is judged by the scope its line
    -- carries, and only a team scope may be shown to readers who are not the asker alone.
    FOR s IN
      SELECT d.source_type, d.source_ref, d.scope
        FROM (SELECT DISTINCT ON (l.source_type, l.source_ref) l.seq, l.source_type, l.source_ref, l.scope
                FROM app.answer_run_sources() l ORDER BY l.source_type, l.source_ref, l.seq) d
       ORDER BY d.seq
       LIMIT 200
    LOOP
      IF s.source_type IN ('message', 'file') THEN
        v_res := app.answer_resolve(s.source_type, s.source_ref, NULL, r.team_id, r.channel_id, v_reach);
      ELSE
        v_res := jsonb_build_object('found', true, 'scope', s.scope, 'audience', v_reach = 'asker' OR (v_reach = 'team' AND s.scope = 'team'));
      END IF;
      v_sources := v_sources || jsonb_build_array(
        v_res || jsonb_build_object('kind', s.source_type, 'ref', s.source_ref, 'logScope', s.scope));
    END LOOP;

    IF coalesce(array_length(p_slugs, 1), 0) > 0 THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'slug', b.slug, 'name', b.name)), '[]'::jsonb) INTO v_bots
        FROM app.bots b
       WHERE b.team_id = r.team_id AND b.slug = ANY (p_slugs) AND b.status = 'active' AND b.id <> r.bot_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- the block is already rolled back, identity switch included; say it again so the caller never reads this as the asker
    PERFORM set_config('app.actor_id', coalesce(v_actor_was, ''), true);
    PERFORM set_config('app.actor_kind', coalesce(v_kind_was, ''), true);
    RAISE;
  END;

  -- back to the bot: the caller's own transaction goes on as it was
  PERFORM set_config('app.actor_id', coalesce(v_actor_was, ''), true);
  PERFORM set_config('app.actor_kind', coalesce(v_kind_was, ''), true);

  RETURN jsonb_build_object(
    'run', jsonb_build_object(
      'runId', r.id, 'botId', r.bot_id, 'botName', v_bot_name, 'botSlug', v_bot_slug, 'alias', v_alias,
      'teamId', r.team_id, 'workspaceId', r.workspace_id, 'trigger', r.trigger_type,
      'hasAsker', r.asker_id IS NOT NULL, 'askerPersonId', v_person, 'askerName', v_name,
      'channelId', r.channel_id, 'replyRootId', r.reply_root_id, 'private', v_priv, 'reach', v_reach, 'logTruncated', v_trunc),
    'citations', v_cites,
    'sources', v_sources,
    'bots', v_bots);
END
$$;

-- Same grants and owner as 0001 (CREATE OR REPLACE keeps both; stated again so a reader of this file sees them).
REVOKE ALL ON FUNCTION app.answer_run_sources() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.answer_view(jsonb, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.answer_run_sources() TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.answer_view(jsonb, text[]) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.answer_run_sources() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
