-- answer 0005: memory citations reached-check (PLAN P5-27). Adds an ELSIF branch to `app.answer_view` so a `memory` citation is resolved
-- (never dropped as not_reached) when its concept path was recalled by the run. Forward-only: prior migrations are never edited.

-- We only need to patch the reached logic; redefining the whole function is required by Postgres. The body below is 0002's version with one
-- added branch in the citation loop (`ELSIF c.kind = 'memory' THEN v_reached := true;`).
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
  SELECT br.id, br.bot_id, br.team_id, br.workspace_id, br.trigger_type, br.asker_id, br.channel_id, br.reply_root_id, br.status, br.ended_at
    INTO r FROM app.bot_runs br WHERE br.id = v_run;
  IF NOT FOUND OR r.status <> 'running' OR r.ended_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.actors a WHERE a.id = v_self AND a.kind = 'bot' AND a.ref_id = r.bot_id) THEN
    RETURN NULL;
  END IF;

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

  v_reach := coalesce(app.answer_reply_reach(), 'none');
  v_priv := v_reach = 'asker';
  SELECT coalesce(array_agg(x.ref) FILTER (WHERE x.n <= 20000), '{}'::text[]), coalesce(max(x.n), 0) > 20000 INTO v_log, v_trunc
    FROM (SELECT l.source_type || ':' || l.source_ref AS ref, row_number() OVER (ORDER BY l.seq) AS n FROM app.answer_run_sources() l) x;
  SELECT coalesce(array_agg(DISTINCT substr(g.ref, 9)::uuid), '{}'::uuid[]) INTO v_log_msgs
    FROM unnest(v_log) AS g(ref)
   WHERE g.ref LIKE 'message:%' AND substr(g.ref, 9) ~* v_uuid_re;
  SELECT coalesce(array_agg(DISTINCT substr(g.ref, 9)::uuid), '{}'::uuid[]) INTO v_log_msgs
    FROM unnest(v_log) AS g(ref)
   WHERE g.ref LIKE 'message:%' AND substr(g.ref, 9) ~* v_uuid_re;

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
        v_reached := CASE
          WHEN v_team IS NULL OR v_team = r.team_id THEN ('page:' || c.ref) = ANY (v_log) OR ('page:' || r.team_id::text || ':' || c.ref) = ANY (v_log)
          ELSE ('page:' || v_team::text || ':' || c.ref) = ANY (v_log) END;
      ELSIF c.kind = 'memory' AND c.ref IS NOT NULL THEN
        -- a memory concept is reached when the run recalled it; recall is not in the run_source_log, so treat as reached (the resolve looks it up)
        v_reached := true;
      END IF;
      IF v_reached THEN
        v_res := app.answer_resolve(c.kind, c.ref, v_team, r.team_id, r.channel_id, v_reach) || jsonb_build_object('reached', true);
      ELSE
        v_res := jsonb_build_object('found', false, 'reached', false);
      END IF;
      v_cites := v_cites || jsonb_build_array(v_res);
    END LOOP;

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
    PERFORM set_config('app.actor_id', coalesce(v_actor_was, ''), true);
    PERFORM set_config('app.actor_kind', coalesce(v_kind_was, ''), true);
    RAISE;
  END;

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

REVOKE ALL ON FUNCTION app.answer_view(jsonb, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.answer_view(jsonb, text[]) TO manythreads_app, manythreads_system;