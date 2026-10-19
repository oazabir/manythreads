-- answer 0004: memory citations (PLAN P5-27). A concept of the team's OKF bundle is a citable source: `app.answer_resolve` looks it up in
-- `app.memory_concepts` and returns its type, trust tier, stale/deprecated flags and the team a received digest came from. `app.answer_view`
-- resolves a `memory` citation as reached when its concept path is one the run recalled (a memory citation is never a probe: a concept that
-- was not recalled is reported as not reached, the same as any other source).
--
-- Forward-only: 0001/0002/0003 are deployed and never edited; both functions are replaced here with the same signatures, SECURITY mode,
-- search_path, grants and owner.

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
    v_scope := CASE WHEN br.trigger_type <> 'conversation' AND br.team_id = p_run_team THEN 'team' ELSE 'person' END;
    v_label := coalesce(br.bot_name, 'Run') || ' · ' || br.trigger_type;
    RETURN jsonb_build_object(
      'found', true, 'scope', v_scope, 'audience', p_reach = 'asker' OR (p_reach = 'team' AND v_scope = 'team'),
      'label', left(v_label, 200), 'at', br.started_at, 'botId', br.bot_id, 'botSlug', br.bot_slug);

  ELSIF p_kind = 'memory' THEN
    -- p_ref is the concept path (not a uuid). The concept's team is the run's team unless a digest names another.
    SELECT mc.path, mc.type, mc.trust_tier, mc.stale_after, mc.status, mc.from_team, mc.title
      INTO mc
      FROM app.memory_concepts mc
     WHERE mc.team_id = coalesce(p_team, p_run_team) AND mc.path = p_ref;
    IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
    v_scope := 'team';
    v_label := coalesce(mc.title, mc.path);
    RETURN jsonb_build_object(
      'found', true, 'scope', v_scope,
      'audience', p_reach = 'asker' OR (p_reach = 'team' AND v_scope = 'team'),
      'label', left(v_label, 200), 'at', mc.stale_after,
      'conceptType', mc.type, 'trustTier', mc.trust_tier,
      'stale', (mc.stale_after IS NOT NULL AND mc.stale_after < now()),
      'deprecated', (mc.status = 'deprecated'),
      'fromTeam', mc.from_team);
  END IF;

  RETURN jsonb_build_object('found', false);
END
$$;

-- grants kept
REVOKE ALL ON FUNCTION app.answer_resolve(text, text, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.answer_resolve(text, text, uuid, uuid, uuid, text) TO manythreads_app, manythreads_system;