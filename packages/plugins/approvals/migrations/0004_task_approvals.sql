-- approvals plugin 0004 (PLAN P6-03/P6-05): approvals that do not hang from a bot run.
--
-- The four sources were one mechanism already, but every row was filed from a run (`app.approvals_request` reads the bot, team, asker and
-- thread from `bot_runs`). A task handover (`dispatch: strict`) and a deploy into a `protected` environment can be asked for by a person
-- driving the board, with no run behind them. This door files those two: the caller names the workspace, team and requester, the scope is
-- always the team's leads (role:/person: approvers for a task arrive with the runtime in a later task), and the row has no bot, no run and
-- no channel: the whole team that can read it may decide it, never the requester (app.approvals_block_reasons refuses that already).
--
-- Written by a definer function owned by manythreads_system, like 0001's doors; the app role gets EXECUTE and no INSERT.

CREATE FUNCTION app.approvals_request_task(
  p_workspace_id uuid, p_team_id uuid, p_requester uuid, p_source text, p_tool text, p_summary text, p_resume jsonb, p_dedupe_key text
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_id   uuid;
  v_name text;
  v_scope jsonb := jsonb_build_object('roles', '[]'::jsonb, 'people', '[]'::jsonb, 'leads', true);
BEGIN
  IF p_source NOT IN ('dispatch', 'environment') THEN
    RAISE EXCEPTION 'a task approval is dispatch or environment, not %', p_source USING ERRCODE = '22023';
  END IF;
  IF p_resume IS NULL OR p_resume ->> 'kind' <> 'handoff' THEN
    RAISE EXCEPTION 'a task approval resumes a handoff' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM app.actors a WHERE a.id = p_requester AND a.workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the requester is not an actor of this workspace' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM app.teams t WHERE t.id = p_team_id AND t.workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that team is not in this workspace' USING ERRCODE = '23503';
  END IF;
  SELECT coalesce(p.display_name, b.name, 'someone') INTO v_name
    FROM app.actors k
    LEFT JOIN app.people p ON p.id = k.ref_id AND k.kind = 'person'
    LEFT JOIN app.bots b ON b.id = k.ref_id AND k.kind = 'bot'
   WHERE k.id = p_requester;
  -- A pending row of the same requester, tool and key is the same ask: keep one (a person double-clicking a drag must not fill the inbox).
  IF p_dedupe_key IS NOT NULL THEN
    SELECT a.id INTO v_id FROM app.approvals a
     WHERE a.requester_id = p_requester AND a.tool = p_tool AND a.dedupe_key = p_dedupe_key
       AND a.status = 'pending' AND a.expires_at > now()
     LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  INSERT INTO app.approvals (workspace_id, team_id, source, tool, summary, args_preview, args_truncated, resume,
                             approver_scope, requester_id, requester_name, bot_id, run_id, channel_id, thread_root_id, dedupe_key)
  VALUES (p_workspace_id, p_team_id, p_source, left(p_tool, 200), left(coalesce(p_summary, p_tool), 300), '{}'::jsonb, false, p_resume,
          v_scope, p_requester, coalesce(v_name, 'someone'), NULL, NULL, NULL, NULL, left(p_dedupe_key, 200))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.approvals_request_task(uuid, uuid, uuid, text, text, text, jsonb, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

REVOKE ALL ON FUNCTION app.approvals_request_task(uuid, uuid, uuid, text, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approvals_request_task(uuid, uuid, uuid, text, text, text, jsonb, text) TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.approvals_request_task(uuid, uuid, uuid, text, text, text, jsonb, text) IS
  'File a pending approval that hangs from no bot run (a strict task handoff, a protected deploy): the approvers are the team leads, and the requester can never decide it.';
