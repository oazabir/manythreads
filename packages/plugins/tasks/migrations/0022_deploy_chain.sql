-- tasks plugin 0022 (P35-03, docs/plans/test-site-per-card.md): a protected environment may ask a chain of people by role before a deploy. Forward-only.
--
-- `environments.approval_chain` lists up to three role tags. A deploy that needs approval and has a chain files its first step for the holders of the
-- first role (approvals 0009: not the leads, and never the requester); when that step is approved, `tasks_advance_deploy` files the next step for the next
-- role, excluding everyone who decided an earlier step, and records the deploy only once the last step is approved. A denial at any step ends the
-- request; nothing is deployed. An environment with no chain keeps the one approval by a lead (0001).

ALTER TABLE app.environments
  ADD COLUMN approval_chain text[] NOT NULL DEFAULT '{}' CHECK (cardinality(approval_chain) <= 3 AND array_position(approval_chain, '') IS NULL);

ALTER TABLE app.deploy_requests
  ADD COLUMN chain_step integer NOT NULL DEFAULT 0 CHECK (chain_step BETWEEN 0 AND 2),
  ADD COLUMN chain_deciders uuid[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION app.tasks_deploy_request(p_environment_id uuid, p_task_id uuid, p_note text)
  RETURNS TABLE (o_outcome text, o_reason text, o_approval_id uuid, o_deploy_id bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor   uuid := app.actor();
  v_check   record;
  v_env     record;
  v_approval uuid;
  v_deploy  bigint;
  v_resume  jsonb;
BEGIN
  SELECT * INTO v_check FROM app.tasks_deploy_check(p_environment_id, p_task_id);
  IF v_check.o_outcome = 'not_found' THEN
    RETURN QUERY SELECT 'not_found'::text, v_check.o_reason, NULL::uuid, NULL::bigint;
    RETURN;
  END IF;
  IF v_check.o_outcome IN ('outside_window', 'cap_reached') THEN
    RETURN QUERY SELECT v_check.o_outcome, v_check.o_reason, NULL::uuid, NULL::bigint;
    RETURN;
  END IF;
  SELECT e.* INTO v_env FROM app.environments e WHERE e.id = p_environment_id;
  IF v_check.o_outcome = 'needs_approval' THEN
    v_resume := jsonb_build_object('kind', 'handoff', 'op', 'deploy', 'environmentId', v_env.id, 'taskId', p_task_id, 'note', left(coalesce(p_note, ''), 300));
    IF cardinality(v_env.approval_chain) > 0 THEN
      v_approval := app.approvals_request_task_step(
        v_env.workspace_id, v_env.team_id, coalesce(v_actor, v_env.created_by), 'environment', 'tasks.deploy',
        format('Deploy to %s (step 1 of %s: %s)', v_env.name, cardinality(v_env.approval_chain), v_env.approval_chain[1]),
        v_resume, ARRAY[v_env.approval_chain[1]], '{}'::uuid[]);
    ELSE
      v_approval := app.approvals_request_task(
        v_env.workspace_id, v_env.team_id, coalesce(v_actor, v_env.created_by), 'environment', 'tasks.deploy',
        format('Deploy to %s', v_env.name), v_resume, NULL);
    END IF;
    INSERT INTO app.deploy_requests (approval_id, workspace_id, team_id, environment_id, task_id, actor_id, note)
    VALUES (v_approval, v_env.workspace_id, v_env.team_id, v_env.id, p_task_id, v_actor, left(coalesce(p_note, ''), 300));
    RETURN QUERY SELECT 'needs_approval'::text, v_check.o_reason, v_approval, NULL::bigint;
    RETURN;
  END IF;
  v_deploy := app.tasks_record_deploy(p_environment_id, p_task_id, v_actor, p_note);
  RETURN QUERY SELECT 'deployed'::text, ''::text, NULL::uuid, v_deploy;
END
$$;

-- An approved step of a deploy request (system: the outbox consumer of `approvals.approval.decided`). The last step records the deploy (0001's
-- `tasks_apply_deploy`, latched by `applied_at`); an earlier one files the next step and moves the request to it. Outcomes: deployed, next_step, none.
CREATE FUNCTION app.tasks_advance_deploy(p_approval_id uuid)
  RETURNS TABLE (o_outcome text, o_approval_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_req     record;
  v_env     record;
  v_decider uuid;
  v_next    uuid;
  v_appr    record;
BEGIN
  SELECT r.* INTO v_req FROM app.deploy_requests r WHERE r.approval_id = p_approval_id AND r.applied_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'none'::text, NULL::uuid; RETURN; END IF;
  SELECT e.* INTO v_env FROM app.environments e WHERE e.id = v_req.environment_id;
  IF cardinality(v_env.approval_chain) <= v_req.chain_step + 1 THEN
    PERFORM app.tasks_apply_deploy(p_approval_id);
    RETURN QUERY SELECT 'deployed'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT d.decider_id INTO v_decider FROM app.approval_decisions d WHERE d.approval_id = p_approval_id;
  SELECT a.* INTO v_appr FROM app.approvals a WHERE a.id = p_approval_id;
  v_next := app.approvals_request_task_step(
    v_req.workspace_id, v_req.team_id, v_appr.requester_id, 'environment', 'tasks.deploy',
    format('Deploy to %s (step %s of %s: %s)', v_env.name, v_req.chain_step + 2, cardinality(v_env.approval_chain), v_env.approval_chain[v_req.chain_step + 2]),
    v_appr.resume, ARRAY[v_env.approval_chain[v_req.chain_step + 2]], array_append(v_req.chain_deciders, v_decider));
  -- the request now waits on the next step's approval
  UPDATE app.deploy_requests
     SET approval_id = v_next, chain_step = chain_step + 1, chain_deciders = array_append(chain_deciders, v_decider)
   WHERE approval_id = p_approval_id;
  RETURN QUERY SELECT 'next_step'::text, v_next;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_advance_deploy(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_advance_deploy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_advance_deploy(uuid) TO manythreads_system;
