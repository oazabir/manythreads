-- answer 0007: citations carry their space (P20-08, D10). Forward-only: never edit once applied.
--
-- A source of the answer now says which space it was read from: `person:<id>` (a person's own Memory or Personal file) or `team:<id>`. `app.answer_resolve` is
-- replaced here with the same signature, mode, search_path, grants and owner (so `answer_view` and `answer_share_view` need no change) with three additions:
--
--   * a `memory` citation whose ref is `person:<uuid>:<concept path>` is looked up in the owner's Personal Memory (`app.memory_personal_files`, under the asker's own
--     row-level security). It is `scope: person` and its `audience` is true ONLY in the owner's own conversation (`reach = asker` and the owner is the caller): never in a
--     team channel, never in a copy another person reads;
--   * a `file` in a person's Personal space is `scope: person` with the same audience rule (before, it fell to the `channel` scope by accident);
--   * a team concept of a team other than the run's own is `scope: channel`, not `team`: the asker reads it, the reply's readers are not shown it.
--
-- `answer_share_view` already keeps only the message, file, page and run entries it can prove against the target and masks every other kind, so a `memory`
-- citation of either space is masked in a shared copy today; a Personal file is masked through the `person` scope above. The tests pin both.

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
  v_at    timestamptz;
  v_owner uuid;
  v_path  text;
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
