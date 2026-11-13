-- P24: a bot's own question (`source = 'agent'`) may be answered by the person the bot is working for.
-- The "you asked for this" rule keeps a person from approving a call a bot makes on their behalf; for a question the bot asks, the person it is
-- working for is exactly who should answer (in a team with one lead who started the thread, nobody else could). So, for `agent` only:
--   * app.approvals_block_reasons: the requester is not refused (a guest still is), and may decide next to the approvers;
--   * app.approvals_request: a private conversation where only the requester could decide is not refused (AP001).
-- Everything else is the function of 0001, unchanged. CREATE OR REPLACE keeps the owner and the grants.

CREATE OR REPLACE FUNCTION app.approvals_block_reasons(p_ids uuid[]) RETURNS TABLE (o_id uuid, o_reason text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor  uuid := app.actor();
  v_ws     uuid := app.workspace_id();
  v_kind   text;
  v_person uuid;
  v_role   text;
  v_teams  uuid[];
  v_chans  uuid[];
  v_held   text[] := '{}';
  v_leads  uuid[] := '{}';
BEGIN
  IF v_actor IS NOT NULL AND v_ws IS NOT NULL THEN
    SELECT k.kind, k.ref_id INTO v_kind, v_person FROM app.actors k WHERE k.id = v_actor AND k.workspace_id = v_ws;
  END IF;
  v_teams := coalesce(app.readable_team_ids('read'), '{}');
  v_chans := coalesce(app.visible_channel_ids('read'), '{}');
  IF v_kind = 'person' THEN
    v_role := app.lookup_workspace_role();
    v_held := ARRAY(SELECT r.name FROM app.role_members rm JOIN app.roles r ON r.id = rm.role_id
                     WHERE rm.person_id = v_person AND rm.workspace_id = v_ws AND r.workspace_id = v_ws);
    v_leads := ARRAY(SELECT tm.team_id FROM app.team_members tm WHERE tm.actor_id = v_actor AND tm.workspace_id = v_ws AND tm.role = 'lead');
  END IF;
  RETURN QUERY
  SELECT u.id,
         CASE
           WHEN a.id IS NULL OR v_ws IS NULL OR a.workspace_id <> v_ws THEN 'not_found'
           WHEN NOT (a.team_id = ANY (v_teams) AND (a.channel_id IS NULL OR a.channel_id = ANY (v_chans))) THEN 'not_found'
           WHEN a.status <> 'pending' OR a.expires_at <= now() THEN 'not_pending'
           WHEN v_kind IS DISTINCT FROM 'person' THEN 'not_approver'
           WHEN a.requester_id = v_actor AND a.source <> 'agent' THEN 'requester'
           WHEN v_role IS NULL OR v_role = 'guest' THEN 'not_approver'
           -- a bot's own question (P24) is answered by the person the bot is working for, as well as by the approvers: they are who it asked
           WHEN a.requester_id = v_actor THEN NULL
           WHEN v_person::text IN (SELECT jsonb_array_elements_text(a.approver_scope -> 'people')) THEN NULL
           WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.approver_scope -> 'roles') AS t(name) WHERE t.name = ANY (v_held)) THEN NULL
           WHEN coalesce((a.approver_scope ->> 'leads')::boolean, false) AND (a.team_id = ANY (v_leads) OR v_role IN ('owner', 'admin')) THEN NULL
           ELSE 'not_approver'
         END
    FROM unnest(p_ids) AS u(id)
    LEFT JOIN app.approvals a ON a.id = u.id;
END
$$;

CREATE OR REPLACE FUNCTION app.approvals_request(
  p_run_id uuid, p_source text, p_tool text, p_summary text, p_args_preview jsonb, p_args_truncated boolean, p_resume jsonb,
  p_approvers text[], p_dedupe_key text
) RETURNS TABLE (o_id uuid, o_created boolean, o_workspace_id uuid, o_team_id uuid, o_bot_id uuid, o_run_id uuid, o_requester_id uuid, o_private boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_run     record;
  v_bot_actor uuid;
  v_list    text[];
  v_scope   jsonb;
  v_id      uuid;
  v_requester uuid;
  v_requester_name text;
  v_try     integer := 0;
  v_private boolean := false;
  v_key     text;
BEGIN
  SELECT r.id, r.workspace_id, r.team_id, r.bot_id, r.asker_id, r.channel_id, r.reply_root_id, r.status
    INTO v_run FROM app.bot_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such run' USING ERRCODE = '23503';
  END IF;
  SELECT a.id INTO v_bot_actor FROM app.actors a WHERE a.kind = 'bot' AND a.ref_id = v_run.bot_id AND a.workspace_id = v_run.workspace_id;
  IF session_user <> 'manythreads_system' THEN
    IF v_bot_actor IS NULL OR v_bot_actor IS DISTINCT FROM app.actor() OR p_run_id IS DISTINCT FROM app.run_id() THEN
      RAISE EXCEPTION 'only the run''s own bot, or the system, may ask for an approval' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_requester := coalesce(v_run.asker_id, v_bot_actor);
  SELECT coalesce(p.display_name, b.name, 'someone') INTO v_requester_name
    FROM app.actors k
    LEFT JOIN app.people p ON p.id = k.ref_id AND k.kind = 'person'
    LEFT JOIN app.bots b ON b.id = k.ref_id AND k.kind = 'bot'
   WHERE k.id = v_requester;
  v_list := coalesce(p_approvers, (SELECT b.approvers FROM app.bots b WHERE b.id = v_run.bot_id), '{}');
  v_scope := jsonb_build_object(
    'roles', coalesce((SELECT jsonb_agg(DISTINCT p) FROM unnest(v_list) AS p WHERE p ~ '^role:[a-z][a-z0-9-]*$'), '[]'::jsonb),
    'people', coalesce((SELECT jsonb_agg(DISTINCT substr(p, 8)) FROM unnest(v_list) AS p
                         WHERE p ~ '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '[]'::jsonb),
    'leads', NOT EXISTS (SELECT 1 FROM unnest(v_list) AS p WHERE p ~ '^role:[a-z][a-z0-9-]*$'
                    OR p ~ '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );

  -- A conversation that is private (a private channel, a DM, a bot conversation) is decided by the people in it. If nobody in it but the
  -- requester could decide this, the approval would sit undecidable and invisible to everyone who could help: refuse it, with a reason the
  -- caller can say (SQLSTATE AP001), instead of filing it.
  IF v_run.channel_id IS NOT NULL THEN
    SELECT coalesce(c.private, false) INTO v_private FROM app.channels c WHERE c.id = v_run.channel_id;
    IF v_private AND p_source <> 'agent' AND NOT EXISTS (
      SELECT 1
        FROM app.channel_members cm
        JOIN app.people pe ON pe.id = cm.person_id AND pe.status = 'active'
        JOIN app.workspace_members wm ON wm.person_id = pe.id AND wm.workspace_id = v_run.workspace_id AND wm.role <> 'guest'
        JOIN app.actors k ON k.kind = 'person' AND k.ref_id = pe.id AND k.workspace_id = v_run.workspace_id
        LEFT JOIN app.team_members tm ON tm.team_id = v_run.team_id AND tm.actor_id = k.id
       WHERE cm.channel_id = v_run.channel_id
         AND k.id <> v_requester
         AND (tm.actor_id IS NOT NULL OR wm.role IN ('owner', 'admin'))
         AND (pe.id::text IN (SELECT jsonb_array_elements_text(v_scope -> 'people'))
              OR EXISTS (SELECT 1 FROM app.role_members rm JOIN app.roles r ON r.id = rm.role_id
                          WHERE rm.person_id = pe.id AND rm.workspace_id = v_run.workspace_id AND r.workspace_id = v_run.workspace_id
                            AND r.name IN (SELECT jsonb_array_elements_text(v_scope -> 'roles')))
              OR (coalesce((v_scope ->> 'leads')::boolean, false) AND (tm.role = 'lead' OR wm.role IN ('owner', 'admin'))))
    ) THEN
      RAISE EXCEPTION 'nobody but the person who asked can read this conversation and decide this' USING ERRCODE = 'AP001';
    END IF;
  END IF;

  -- The key also names the conversation the run answers in: the same call asked from another channel or thread is an approval of its own.
  v_key := CASE WHEN p_dedupe_key IS NULL THEN NULL
                ELSE left(p_dedupe_key, 100) || ':' || coalesce(v_run.channel_id::text, '-') || ':' || coalesce(v_run.reply_root_id::text, '-') END;
  -- A pending approval of the same key that lapsed and has not been swept yet is not a duplicate: it is expired first, so a repeat after the
  -- time ran out files a fresh one instead of being handed a row nobody can decide.
  IF v_key IS NOT NULL THEN
    UPDATE app.approvals x SET status = 'expired', decided_at = now()
     WHERE x.bot_id = v_run.bot_id AND x.requester_id = v_requester AND x.dedupe_key = v_key AND x.status = 'pending' AND x.expires_at <= now();
  END IF;

  -- insert; on a duplicate pending key of the same asker take the existing one; if that one was decided in the meantime (so the conflict is
  -- gone and the lookup finds nothing), go round again — the insert then succeeds. Bounded, and never answers a NULL id.
  LOOP
    v_try := v_try + 1;
    INSERT INTO app.approvals AS a (workspace_id, team_id, source, tool, summary, args_preview, args_truncated, resume, approver_scope, requester_id,
                                    bot_id, run_id, channel_id, thread_root_id, dedupe_key, requester_name)
    VALUES (v_run.workspace_id, v_run.team_id, p_source, p_tool, p_summary, coalesce(p_args_preview, '{}'::jsonb), coalesce(p_args_truncated, false),
            p_resume, v_scope, v_requester, v_run.bot_id, v_run.id, v_run.channel_id, v_run.reply_root_id, v_key,
            coalesce(v_requester_name, 'someone'))
    ON CONFLICT (bot_id, requester_id, dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL DO NOTHING
    RETURNING a.id INTO v_id;
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, true, v_run.workspace_id, v_run.team_id, v_run.bot_id, v_run.id, v_requester, v_private;
      RETURN;
    END IF;
    SELECT a.id INTO v_id FROM app.approvals a
     WHERE a.bot_id = v_run.bot_id AND a.requester_id = v_requester AND a.dedupe_key = v_key AND a.status = 'pending' AND a.expires_at > now();
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, false, v_run.workspace_id, v_run.team_id, v_run.bot_id, v_run.id, v_requester, v_private;
      RETURN;
    END IF;
    IF v_try >= 5 THEN
      RAISE EXCEPTION 'could not file the approval (concurrent changes)' USING ERRCODE = '40001';
    END IF;
  END LOOP;
END
$$;
