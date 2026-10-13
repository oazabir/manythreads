-- answer 0001: the asker's view of an Answer (PLAN P5-18, SPEC §12.4). Forward-only: never edit once applied.
--
-- A bot finishes a reply with the `answer.post` tool: a text, the sources it cites by id, and some suggestions. Before that becomes a message,
-- the platform has to say, for every cited source and for everything the run read, two things the bot cannot be trusted with:
--
--   1. may the PERSON WHO ASKED read it?  (the Answer is "scoped to the asker", SPEC §1.7: a citation the asker cannot open is never shown,
--      and its title and snippet are never copied into a message)
--   2. may the PEOPLE WHO WILL READ THE REPLY read it?  (a reply in a team channel is read by the channel, not only by the asker; a private
--      source cited there is the §6.3 masking problem, decided here at post time rather than at share time)
--
-- The first question is the platform's own row level security, asked as the asker: this migration adds NO policy and no copy of one. The
-- functions below are SECURITY INVOKER — they run as the caller's role (`manythreads_app`, whose policies are FORCEd) — and switch the
-- transaction's identity to the run's asker for the duration of the call, exactly the identity `ctx.runs.asReader` would give a read tool
-- (`app.actor_id`, `app.actor_kind`; the workspace and the run id stay). Only the asker of THE CALLER'S OWN LIVE RUN can be impersonated:
-- the function reads the run from `app.run_id()` and refuses unless the transaction's actor is that run's bot. Nobody names a person, a run
-- or a workspace; there is no argument that would. Inside an INVOKER function `app.is_system()` is false (a name comparison on the
-- current role, kernel 0003), so nothing the asker could not read is read here.
--
-- A third thing is decided here and not by the bot: WHAT THE BOT REACHED. A citation is read only when the run's own source log says it reached
-- the source (a search hit, a file, a page or run it opened, the thread it answers in). Anything else is `reached: false` and is not even
-- looked up: whether the asker could read an id the bot never saw is not something a bot may learn by citing it.
--
--   * app.answer_run_sources()    SECURITY DEFINER, system-owned: the calling run's own source log (a bot cannot read its run's lines under
--                                 `run_source_log_select`, bots 0004). The one run it answers for is `app.run_id()`.
--   * app.answer_reply_team_only() SECURITY DEFINER, system-owned: are the people who can read the run's reply channel all of the run's team
--                                 (or workspace admins, who read every team)? Decided from the channel's actual readers
--                                 (`app.channel_audience`, so an ACL grant to a guest or to a person of another team counts), never from a
--                                 label on the source.
--   * app.answer_resolve(...)     one source seen as the current actor: found, how far it reaches, whether the reply's readers may see it,
--                                 and the words to label it with. Pure reads under RLS.
--   * app.answer_view(...)        the whole view of one answer: the run, every citation, every source reached, the bots a hand-off may name.

CREATE FUNCTION app.answer_run_sources() RETURNS TABLE (seq integer, source_type text, source_ref text, scope text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT l.seq, l.source_type, l.source_ref, l.scope
    FROM app.run_source_log l
    JOIN app.bot_runs r ON r.id = l.run_id
    JOIN app.actors bot ON bot.kind = 'bot' AND bot.ref_id = r.bot_id AND bot.workspace_id = r.workspace_id
   WHERE l.run_id = app.run_id()
     AND r.status = 'running' AND r.ended_at IS NULL
     AND (app.actor() = bot.id OR (r.asker_id IS NOT NULL AND app.actor() = r.asker_id))
   ORDER BY l.seq
   LIMIT 2000
$$;

-- Are the people who can read the calling run's reply channel all people who can read the run's team's own sources? True only for a channel of
-- the run's team whose ACTUAL readers (`app.channel_audience`: the team, the workspace's owners and admins, whoever an ACL entry names, a member
-- of a private channel only while on its team) are each on that team or a workspace owner/admin — those read every public channel, page, file and
-- run of the team. A channel a guest or a person of another team can read (an ACL entry), a direct message and anything the bot cannot read are
-- false: a team source cited there would be shown to somebody who may not open it. Answers for `app.run_id()` only, to that run's bot, and a
-- channel with no readers at all is false (nothing is proven by an empty set).
CREATE FUNCTION app.answer_reply_team_only() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT coalesce((
    SELECT c.kind = 'channel' AND c.team_id = r.team_id AND c.workspace_id = r.workspace_id
           AND app.lookup_channel_can(c.id, 'read')
           AND EXISTS (SELECT 1 FROM app.channel_audience(c.id) AS any_reader)
           AND NOT EXISTS (
             SELECT 1 FROM app.channel_audience(c.id) AS a
              WHERE NOT EXISTS (SELECT 1 FROM app.workspace_members wm
                                 WHERE wm.workspace_id = c.workspace_id AND wm.person_id = a.person_id AND wm.role IN ('owner', 'admin'))
                AND NOT EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors pa ON pa.id = tm.actor_id AND pa.kind = 'person'
                                 WHERE tm.team_id = c.team_id AND pa.ref_id = a.person_id))
      FROM app.bot_runs r
      JOIN app.channels c ON c.id = r.channel_id
      JOIN app.actors bot ON bot.kind = 'bot' AND bot.ref_id = r.bot_id AND bot.workspace_id = r.workspace_id
     WHERE r.id = app.run_id() AND r.status = 'running' AND r.ended_at IS NULL AND app.actor() = bot.id
  ), false)
$$;

-- One source, seen by whoever the transaction is. `p_run_team` is the team of the run, `p_reply_channel` the channel the reply goes to and
-- `p_reach` who will read the reply: `asker` (the asker's own conversation: everybody who can read it is the asker), `team` (the run's team and
-- nobody else: a team source may be shown) or `none` (anyone else may read it: only what lives in the reply's own channel may be shown). Never
-- raises for a source that is missing or hidden: both are `{ "found": false }`, so the caller cannot tell them apart and neither can the bot.
CREATE FUNCTION app.answer_resolve(p_kind text, p_ref text, p_team uuid, p_run_team uuid, p_reply_channel uuid, p_reach text)
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
  v_at    timestamptz;
BEGIN
  IF p_kind IN ('message', 'thread', 'file', 'run') THEN
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
    -- a file of a team repo, by path; the run's own team when none is named. The index row is readable by whoever reads the team.
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
    SELECT fi.id, fi.name, fi.channel_id, fi.team_id, fi.created_at, c.kind AS ckind, c.private AS cprivate, c.team_id AS cteam
      INTO f
      FROM app.files fi
      LEFT JOIN app.channels c ON c.id = fi.channel_id
     WHERE fi.id = v_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
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
    -- a person's own conversation run is theirs alone (bots 0011): it reaches no further than they do
    v_scope := CASE WHEN br.trigger_type <> 'conversation' AND br.team_id = p_run_team THEN 'team' ELSE 'person' END;
    v_label := coalesce(br.bot_name, 'Run') || ' · ' || br.trigger_type;
    RETURN jsonb_build_object(
      'found', true, 'scope', v_scope, 'audience', p_reach = 'asker' OR (p_reach = 'team' AND v_scope = 'team'),
      'label', left(v_label, 200), 'at', br.started_at, 'botId', br.bot_id, 'botSlug', br.bot_slug);
  END IF;

  RETURN jsonb_build_object('found', false);
END
$$;

-- The view of one answer. `p_cites` is `[{ "kind", "ref", "team" }]` in the order the bot sent them (result `citations` has the same indexes);
-- `p_slugs` the bots a hand-off chip names. Answers NULL when the transaction is not a live run's own bot (nothing to say, nobody to say it
-- for), and `{ "already": "<message id>" }` when this run has already posted its answer (one answer per run: the run's advisory lock is taken
-- before the look, so two calls of one run in parallel go one after the other and the second finds the first one's message — a message that
-- was deleted does not count, the answer is gone).
--
-- Every citation comes back as the asker's reading of it plus `reached`: whether the run's own source log says the bot reached it (a search
-- hit or a file it listed, a page or run it opened, the thread it answers in). A citation that was not reached is
-- `{ "found": false, "reached": false }` and is never looked up: a bot learns nothing about an id it did not see.
CREATE FUNCTION app.answer_view(p_cites jsonb, p_slugs text[]) RETURNS jsonb
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
  v_team_only boolean;
  v_reach     text;
  v_log       text[];
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
  v_team_only := coalesce(app.answer_reply_team_only(), false);
  SELECT coalesce(array_agg(l.source_type || ':' || l.source_ref), '{}'::text[]) INTO v_log FROM app.answer_run_sources() l;

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
    IF r.channel_id IS NOT NULL THEN
      SELECT (c2.kind = 'bot_conversation') INTO v_priv FROM app.channels c2 WHERE c2.id = r.channel_id;
      v_priv := coalesce(v_priv, false) AND r.asker_id IS NOT NULL;
    END IF;
    -- who will read the reply: the asker alone (their own conversation), the run's team (and workspace admins), or somebody else too
    v_reach := CASE WHEN v_priv THEN 'asker' WHEN v_team_only THEN 'team' ELSE 'none' END;

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
        v_reached := ('thread:' || lower(c.ref)) = ANY (v_log) OR ('message:' || lower(c.ref)) = ANY (v_log)
          OR v_id = r.reply_root_id
          OR EXISTS (SELECT 1 FROM app.messages x WHERE x.thread_root_id = v_id AND ('message:' || x.id::text) = ANY (v_log));
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
      'channelId', r.channel_id, 'replyRootId', r.reply_root_id, 'private', v_priv, 'reach', v_reach),
    'citations', v_cites,
    'sources', v_sources,
    'bots', v_bots);
END
$$;

-- Only the transaction's own live run is ever answered for, and only for its bot (or its asker, for the sources): no caller can ask about
-- another run or another person, so the grant is the application role's and the system role's, as for the other run doors.
REVOKE ALL ON FUNCTION app.answer_run_sources() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.answer_reply_team_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.answer_resolve(text, text, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.answer_view(jsonb, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.answer_run_sources() TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.answer_reply_team_only() TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.answer_resolve(text, text, uuid, uuid, uuid, text) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.answer_view(jsonb, text[]) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.answer_run_sources() OWNER TO manythreads_system;
ALTER FUNCTION app.answer_reply_team_only() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

COMMENT ON FUNCTION app.answer_run_sources() IS
  'The calling run''s own source log (answer plugin): system-owned because the run''s bot cannot read its lines; answers for app.run_id() only, to that run''s bot or asker.';
COMMENT ON FUNCTION app.answer_reply_team_only() IS
  'Whether everybody who can read the calling run''s reply channel is on the run''s team or a workspace owner/admin (answer plugin): decided from the channel''s actual readers, for app.run_id() only, to that run''s bot.';
COMMENT ON FUNCTION app.answer_resolve(text, text, uuid, uuid, uuid, text) IS
  'One cited source seen as the current actor (SECURITY INVOKER, so RLS applies): found, how far it reaches (team/channel/person), whether the reply''s readers (asker, team or others) may see it, a label.';
COMMENT ON FUNCTION app.answer_view(jsonb, text[]) IS
  'The asker''s view of one answer, for the calling bot''s own live run (SECURITY INVOKER; the transaction acts as the run''s asker while it reads, then goes back to the bot): every citation the run reached, as the asker may read it; one answer per run (advisory lock). NULL when the caller is not a live run''s bot.';
