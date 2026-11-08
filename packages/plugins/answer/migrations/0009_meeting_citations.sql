-- answer 0009: a meeting can be cited (PLAN P15-13). Forward-only: never edit once applied.
--
-- A citation of kind `meeting` names a meeting by id (and a time on its clock, which the builder carries and the database does not need). Two functions learn it, and nothing
-- else changes (same signatures, modes, search_path, grants and owner as 0005 and 0008):
--
--   * `app.answer_view` calls a meeting reached when the run's source log holds `meeting:<id>`; the gateway writes that line for every meeting a `meetings.search` call answered
--     (gateway-mcp `meetingHitsFrom`), so a run cannot cite a meeting it never searched;
--   * `app.answer_resolve` reads the meeting as the asker (the room's read policy decides whether it exists for them), says how far it reaches (`team` for a public channel of the
--     run's own team, otherwise `channel`) and whether the reply's readers may open it (the channel is the reply's own, or the reply reaches the team and the meeting does). A
--     note-taker's meeting whose transcript is still the organizer's Personal copy (`app.meeting_privacy`, search 0007) reaches only the organizer, `person` scope, in their own
--     conversation. The label is the meeting's title.
--
-- `answer_share_view` keeps only the message, file, page and run entries it can prove against the target and masks every other kind, so a meeting is masked in a shared copy.

CREATE OR REPLACE FUNCTION app.answer_resolve(p_kind text, p_ref text, p_team uuid, p_run_team uuid, p_reply_channel uuid, p_reach text)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_id    uuid;
  v_scope text;
  v_label text;
  m       record;
  e       record;
  f       record;
  br      record;
  mc      record;
  mt      record;
  v_priv  text;
  v_at    timestamptz;
  v_owner uuid;
  v_path  text;
BEGIN
  IF p_kind IN ('message', 'thread', 'file', 'run', 'meeting') THEN
    IF p_ref IS NULL OR p_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('found', false);
    END IF;
    v_id := p_ref::uuid;
  END IF;

  IF p_kind = 'message' THEN
    SELECT x.id, x.channel_id, x.thread_root_id, x.created_at, x.body_plain, th.title, c.kind AS ckind, c.private AS cprivate, c.team_id AS cteam, c.name AS cname
      INTO m
      FROM app.messages x
      JOIN app.channels c ON c.id = x.channel_id
      LEFT JOIN app.threads th ON th.root_message_id = x.id
     WHERE x.id = v_id AND x.deleted_at IS NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
    v_scope := CASE WHEN m.ckind = 'channel' AND NOT m.cprivate AND m.cteam = p_run_team THEN 'team' ELSE 'channel' END;
    RETURN jsonb_build_object(
      'found', true, 'scope', v_scope,
      'audience', p_reach = 'asker' OR m.channel_id = p_reply_channel OR (p_reach = 'team' AND v_scope = 'team'),
      'label', left(coalesce(nullif(m.title, ''), m.body_plain), 120),
      'at', m.created_at, 'channelId', m.channel_id, 'channelKind', m.ckind, 'teamId', m.cteam,
      'channelName', CASE WHEN m.ckind = 'channel' THEN m.cname END, 'threadRootId', m.thread_root_id);

  ELSIF p_kind = 'thread' THEN
    SELECT th.root_message_id, th.channel_id, th.title, x.created_at, x.body_plain, c.kind AS ckind, c.private AS cprivate, c.team_id AS cteam, c.name AS cname
      INTO m
      FROM app.threads th
      JOIN app.messages x ON x.id = th.root_message_id
      JOIN app.channels c ON c.id = th.channel_id
     WHERE th.root_message_id = v_id AND x.deleted_at IS NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
    v_scope := CASE WHEN m.ckind = 'channel' AND NOT m.cprivate AND m.cteam = p_run_team THEN 'team' ELSE 'channel' END;
    RETURN jsonb_build_object(
      'found', true, 'scope', v_scope,
      'audience', p_reach = 'asker' OR m.channel_id = p_reply_channel OR (p_reach = 'team' AND v_scope = 'team'),
      'label', left(coalesce(nullif(m.title, ''), m.body_plain), 120),
      'at', m.created_at, 'channelId', m.channel_id, 'channelKind', m.ckind, 'teamId', m.cteam,
      'channelName', CASE WHEN m.ckind = 'channel' THEN m.cname END);

  ELSIF p_kind = 'page' THEN
    SELECT en.team_id, en.path, en.last_commit_sha INTO e
      FROM app.repo_entries en
     WHERE en.team_id = coalesce(p_team, p_run_team) AND en.path = p_ref;
    IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
    SELECT rc.committed_at INTO v_at FROM app.repo_commits rc WHERE rc.team_id = e.team_id AND rc.sha = e.last_commit_sha;
    v_scope := CASE WHEN e.team_id = p_run_team THEN 'team' ELSE 'channel' END;
    RETURN jsonb_build_object(
      'found', true, 'scope', v_scope, 'audience', p_reach = 'asker' OR (p_reach = 'team' AND v_scope = 'team'),
      'label', left(e.path, 200), 'at', v_at, 'teamId', e.team_id);

  ELSIF p_kind = 'file' THEN
    SELECT fi.id, fi.name, fi.channel_id, fi.team_id, fi.owner_person_id, fi.created_at, c.kind AS ckind, c.private AS cprivate, c.team_id AS cteam
      INTO f
      FROM app.files fi
      LEFT JOIN app.channels c ON c.id = fi.channel_id
     WHERE fi.id = v_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
    -- a file in someone's Personal space reaches no further than that person: it may be shown only in the owner's own conversation
    IF f.owner_person_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'found', true, 'scope', 'person', 'audience', p_reach = 'asker' AND f.owner_person_id = app.person_id(),
        'label', left(f.name, 200), 'at', f.created_at, 'space', 'person:' || f.owner_person_id::text);
    END IF;
    v_scope := CASE
      WHEN f.channel_id IS NULL THEN CASE WHEN f.team_id = p_run_team THEN 'team' ELSE 'channel' END
      WHEN f.ckind = 'channel' AND NOT f.cprivate AND f.cteam = p_run_team THEN 'team'
      ELSE 'channel' END;
    RETURN jsonb_build_object(
      'found', true, 'scope', v_scope,
      'audience', p_reach = 'asker' OR (f.channel_id IS NOT NULL AND f.channel_id = p_reply_channel) OR (p_reach = 'team' AND v_scope = 'team'),
      'label', left(f.name, 200), 'at', f.created_at);

  ELSIF p_kind = 'run' THEN
    SELECT r.id, r.bot_id, r.team_id, r.trigger_type, r.started_at, b.name AS bot_name, b.slug AS bot_slug
      INTO br
      FROM app.bot_runs r
      LEFT JOIN app.bots b ON b.id = r.bot_id
     WHERE r.id = v_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
    v_scope := CASE WHEN br.trigger_type <> 'conversation' AND br.team_id = p_run_team THEN 'team' ELSE 'person' END;
    v_label := coalesce(br.bot_name, 'Run') || ' · ' || br.trigger_type;
    RETURN jsonb_build_object(
      'found', true, 'scope', v_scope, 'audience', p_reach = 'asker' OR (p_reach = 'team' AND v_scope = 'team'),
      'label', left(v_label, 200), 'at', br.started_at, 'botId', br.bot_id, 'botSlug', br.bot_slug);

  ELSIF p_kind = 'meeting' THEN
    -- The meeting is read as the asker, so the room's read policy already decided; what is added is the Personal-transcript rule (search 0007: a note-taker's transcript is the
    -- organizer's own until they save it). `app.meeting_privacy` belongs to the search plugin: a deployment without it cannot say, so the citation is not found.
    IF to_regprocedure('app.meeting_privacy(uuid)') IS NULL THEN
      RETURN jsonb_build_object('found', false);
    END IF;
    SELECT x.id, x.title, x.channel_id, x.team_id, x.organizer_id, x.started_at, c.kind AS ckind, c.private AS cprivate, c.team_id AS cteam, c.name AS cname
      INTO mt
      FROM app.meetings x
      LEFT JOIN app.channels c ON c.id = x.channel_id
     WHERE x.id = v_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
    EXECUTE 'SELECT app.meeting_privacy($1)' INTO v_priv USING v_id;
    IF v_priv = 'personal' THEN
      -- the organizer's own words, shown only in the organizer's own conversation: never in a team channel, never in a copy another person reads
      IF mt.organizer_id IS DISTINCT FROM app.actor() THEN RETURN jsonb_build_object('found', false); END IF;
      RETURN jsonb_build_object(
        'found', true, 'scope', 'person', 'audience', p_reach = 'asker',
        'label', left(mt.title, 200), 'at', mt.started_at, 'channelId', mt.channel_id, 'channelKind', mt.ckind, 'teamId', mt.team_id,
        'channelName', CASE WHEN mt.ckind = 'channel' THEN mt.cname END);
    END IF;
    v_scope := CASE WHEN mt.ckind = 'channel' AND NOT mt.cprivate AND mt.cteam = p_run_team THEN 'team' ELSE 'channel' END;
    RETURN jsonb_build_object(
      'found', true, 'scope', v_scope,
      'audience', p_reach = 'asker' OR mt.channel_id = p_reply_channel OR (p_reach = 'team' AND v_scope = 'team'),
      'label', left(mt.title, 200), 'at', mt.started_at, 'channelId', mt.channel_id, 'channelKind', mt.ckind, 'teamId', mt.team_id,
      'channelName', CASE WHEN mt.ckind = 'channel' THEN mt.cname END);

  ELSIF p_kind = 'memory' THEN
    -- p_ref is the concept path (not a uuid), or `person:<uuid>:<path>` for a concept of a person's own Memory (a Personal space). The table belongs
    -- to the `memory` plugin: a deployment without it (or a test database that does not carry that plugin's migrations) has no concepts at all, and the
    -- citation is simply not found. The lookups are dynamic so a missing relation is never planned.
    IF p_ref ~* '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:.' THEN
      IF to_regclass('app.memory_personal_files') IS NULL THEN
        RETURN jsonb_build_object('found', false);
      END IF;
      v_owner := substr(p_ref, 8, 36)::uuid;
      v_path := substr(p_ref, 45);
      -- the run must have recalled this person's own bank (the log line `memory:bank:person:<workspace>:<person>`, written only when the bot was allowed to read it):
      -- a citation is no way to ask whether a Personal concept exists, and `answer_view` cannot check a concept's path (recall logs the bank, not each fact)
      IF NOT EXISTS (SELECT 1 FROM app.answer_run_sources() l WHERE l.source_type = 'memory' AND l.source_ref LIKE 'bank:person:%:' || v_owner::text) THEN
        RETURN jsonb_build_object('found', false);
      END IF;
      EXECUTE 'SELECT path, type, trust_tier, stale_after, status, title
                 FROM app.memory_personal_files
                WHERE owner_person_id = $1::uuid AND path = $2'
        INTO mc USING v_owner, v_path;
      -- EXECUTE ... INTO does not set FOUND: an empty result leaves the record's (not null) path null
      IF mc.path IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
      -- Personal reaches only its owner, in the owner's own conversation: never a team channel, never a copy another person reads
      RETURN jsonb_build_object(
        'found', true, 'scope', 'person', 'audience', p_reach = 'asker' AND v_owner = app.person_id(),
        'label', left(coalesce(mc.title, mc.path), 200), 'at', mc.stale_after,
        'conceptType', mc.type, 'trustTier', mc.trust_tier,
        'stale', (mc.stale_after IS NOT NULL AND mc.stale_after < now()),
        'deprecated', (mc.status = 'deprecated'),
        'fromTeam', NULL, 'space', 'person:' || v_owner::text);
    END IF;
    IF to_regclass('app.memory_concepts') IS NULL THEN
      RETURN jsonb_build_object('found', false);
    END IF;
    EXECUTE 'SELECT team_id, path, type, trust_tier, stale_after, status, from_team, title
               FROM app.memory_concepts
              WHERE team_id = $1::uuid AND path = $2'
      INTO mc USING coalesce(p_team, p_run_team), p_ref;
    IF mc.path IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
    -- a concept of the run's own team reaches the team; one of another team the asker also reads is theirs to see, not the reply's readers'
    v_scope := CASE WHEN mc.team_id = p_run_team THEN 'team' ELSE 'channel' END;
    v_label := coalesce(mc.title, mc.path);
    RETURN jsonb_build_object(
      'found', true, 'scope', v_scope,
      'audience', p_reach = 'asker' OR (p_reach = 'team' AND v_scope = 'team'),
      'label', left(v_label, 200), 'at', mc.stale_after,
      'conceptType', mc.type, 'trustTier', mc.trust_tier,
      'stale', (mc.stale_after IS NOT NULL AND mc.stale_after < now()),
      'deprecated', (mc.status = 'deprecated'),
      'fromTeam', mc.from_team, 'space', 'team:' || mc.team_id::text);
  END IF;

  RETURN jsonb_build_object('found', false);
END
$$;

REVOKE ALL ON FUNCTION app.answer_resolve(text, text, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.answer_resolve(text, text, uuid, uuid, uuid, text) TO manythreads_app, manythreads_system;

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
      ELSIF c.kind = 'meeting' AND v_id IS NOT NULL THEN
        -- a meeting is reached when the run's `meetings.search` answered it (the gateway logs each hit's meeting as a source)
        v_reached := ('meeting:' || lower(c.ref)) = ANY (v_log);
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
