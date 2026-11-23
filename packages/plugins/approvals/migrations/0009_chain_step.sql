-- approvals plugin 0009 (P35-03, docs/plans/test-site-per-card.md): one step of an approval chain. A protected environment may name up to three role tags;
-- its deploy asks them in order, one approval per step. This door files a task approval (as 0004's) whose approvers are the holders of the step's roles
-- only (not the leads), and whose scope names the people who decided the earlier steps, so nobody decides two steps of one chain. The check
-- (`approvals_block_reasons`, as 0008 wrote it) gains that one rule. Forward-only.

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
           -- a step of a chain (P35-03): whoever decided an earlier step of the same chain may not decide this one
           WHEN v_actor::text IN (SELECT jsonb_array_elements_text(coalesce(a.approver_scope -> 'exclude', '[]'::jsonb))) THEN 'not_approver'
           -- a bot's own question (P24) is answered by the person the bot is working for, as well as by the approvers: they are who it asked;
           -- not when the bot named who decides (`named`): then only those people (the person it works for too, if named) may answer
           WHEN a.requester_id = v_actor AND NOT coalesce((a.approver_scope ->> 'named')::boolean, false) THEN NULL
           WHEN v_person::text IN (SELECT jsonb_array_elements_text(a.approver_scope -> 'people')) THEN NULL
           WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.approver_scope -> 'roles') AS t(name) WHERE t.name = ANY (v_held)) THEN NULL
           WHEN coalesce((a.approver_scope ->> 'leads')::boolean, false) AND (a.team_id = ANY (v_leads) OR v_role IN ('owner', 'admin')) THEN NULL
           ELSE 'not_approver'
         END
    FROM unnest(p_ids) AS u(id)
    LEFT JOIN app.approvals a ON a.id = u.id;
END
$$;

CREATE FUNCTION app.approvals_request_task_step(
  p_workspace_id uuid, p_team_id uuid, p_requester uuid, p_source text, p_tool text, p_summary text, p_resume jsonb, p_roles text[], p_exclude uuid[]
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_id   uuid;
BEGIN
  IF p_roles IS NULL OR cardinality(p_roles) = 0 OR cardinality(p_roles) > 3 THEN
    RAISE EXCEPTION 'a chain step names one to three roles' USING ERRCODE = '22023';
  END IF;
  -- 0004's door does every other check (source, requester, team) and the insert; the step's scope replaces the leads
  v_id := app.approvals_request_task(p_workspace_id, p_team_id, p_requester, p_source, p_tool, p_summary, p_resume, NULL);
  UPDATE app.approvals
     SET approver_scope = jsonb_build_object('roles', to_jsonb(p_roles), 'people', '[]'::jsonb, 'leads', false,
                                             'exclude', to_jsonb(coalesce(p_exclude, '{}'::uuid[])))
   WHERE id = v_id;
  RETURN v_id;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.approvals_request_task_step(uuid, uuid, uuid, text, text, text, jsonb, text[], uuid[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.approvals_request_task_step(uuid, uuid, uuid, text, text, text, jsonb, text[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approvals_request_task_step(uuid, uuid, uuid, text, text, text, jsonb, text[], uuid[]) TO manythreads_app, manythreads_system;
