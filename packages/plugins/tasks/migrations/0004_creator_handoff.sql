-- tasks plugin 0004: the creator of an unowned card may hand it over (live bug: an Orchestrator bot created two cards, owned neither, and its
-- tasks.handoff was refused as "only the owner or a lead"; creating cards and handing each to its owner is that role's whole job).
-- A handover is allowed to: the card's current owner, a lead of the team, or the card's creator while the card has no owner (a claim always sets
-- the owner, so "no owner" is also "no live claim"). The route and the tool both go through these two functions. Forward-only: 0001 stays as applied.
--
-- A creator who is a PERSON (not the owner, not a lead) may hand an unowned card only to themselves or to a bot of the card's team: a person must
-- not be able to drop work on another member who never agreed to it (handing a card to another person stays a lead's or the owner's call).
-- A bot creator is bounded by its definition's mayTag list in the route/tool instead, so this function does not narrow it further.

CREATE OR REPLACE FUNCTION app.tasks_handoff(p_task_id uuid, p_to uuid, p_mode text, p_note text, p_approval uuid)
  RETURNS TABLE (o_outcome text, o_handoff_id uuid, o_reason text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_to    record;
  v_id    uuid;
  v_state text;
  v_lead  boolean;
BEGIN
  IF p_mode NOT IN ('bot', 'person') THEN
    RAISE EXCEPTION 'mode is bot or person' USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, 'no such card'::text;
    RETURN;
  END IF;
  v_lead := (SELECT app.lookup_can('team', v_task.team_id, 'manage'));
  IF v_task.owner_id IS DISTINCT FROM v_actor
     AND NOT v_lead
     AND NOT (v_task.owner_id IS NULL AND v_task.created_by = v_actor) THEN
    RETURN QUERY SELECT 'not_owner'::text, NULL::uuid, 'only the card''s owner, a lead of its team, or its creator (while nobody owns it) can hand this card over'::text;
    RETURN;
  END IF;
  IF v_task.handoff_count >= 5 THEN
    RETURN QUERY SELECT 'handoff_bound'::text, NULL::uuid, 'this card changed hands five times: a person has to look at it'::text;
    RETURN;
  END IF;
  SELECT a.id, a.kind INTO v_to FROM app.actors a WHERE a.id = p_to AND a.workspace_id = v_task.workspace_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_target'::text, NULL::uuid, 'that is not an actor of this workspace'::text;
    RETURN;
  END IF;
  IF v_to.kind = 'system' OR v_to.id = v_task.owner_id THEN
    RETURN QUERY SELECT 'no_target'::text, NULL::uuid, 'that actor cannot hold a card'::text;
    RETURN;
  END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor AND NOT v_lead
     AND (SELECT a.kind FROM app.actors a WHERE a.id = v_actor) = 'person'
     AND p_to <> v_actor
     AND NOT EXISTS (SELECT 1 FROM app.actors b JOIN app.bots bt ON bt.id = b.ref_id AND bt.workspace_id = b.workspace_id
                      WHERE b.id = p_to AND b.kind = 'bot' AND bt.team_id = v_task.team_id) THEN
    RETURN QUERY SELECT 'not_owner'::text, NULL::uuid, 'as the creator of an unowned card you can hand it to yourself or to a bot of this team; handing it to another person is for the owner or a lead'::text;
    RETURN;
  END IF;
  v_state := CASE WHEN p_mode = 'person' THEN 'waiting_on_person' ELSE 'in_progress' END;
  INSERT INTO app.handoffs (task_id, team_id, from_actor_id, to_actor_id, mode, note, approval_id, applied_at)
  VALUES (p_task_id, v_task.team_id, v_actor, p_to, p_mode, left(coalesce(p_note, ''), 1000), p_approval, now())
  RETURNING id INTO v_id;
  UPDATE app.task_claims SET released_at = now() WHERE task_id = p_task_id AND released_at IS NULL;
  UPDATE app.tasks
     SET owner_id = p_to, state = v_state, handoff_count = handoff_count + 1,
         blocker_reason = CASE WHEN v_state = 'waiting_on_person' THEN coalesce(nullif(p_note, ''), 'waiting on a person') ELSE '' END,
         updated_at = now()
   WHERE id = p_task_id;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'handed_off',
          jsonb_build_object('handoffId', v_id, 'fromActorId', v_actor, 'toActorId', p_to, 'mode', p_mode, 'approvalId', p_approval));
  RETURN QUERY SELECT 'moved'::text, v_id, ''::text;
END
$$;

CREATE OR REPLACE FUNCTION app.tasks_handoff_pending(p_task_id uuid, p_to uuid, p_mode text, p_note text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_to    record;
  v_id    uuid;
  v_lead  boolean;
BEGIN
  IF p_mode NOT IN ('bot', 'person') THEN
    RAISE EXCEPTION 'mode is bot or person' USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO v_task FROM app.tasks t
   WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such card' USING ERRCODE = '23503';
  END IF;
  v_lead := (SELECT app.lookup_can('team', v_task.team_id, 'manage'));
  IF v_task.owner_id IS DISTINCT FROM v_actor
     AND NOT v_lead
     AND NOT (v_task.owner_id IS NULL AND v_task.created_by = v_actor) THEN
    RAISE EXCEPTION 'only the card''s owner, a lead of its team, or its creator (while nobody owns it) can hand this card over' USING ERRCODE = '42501';
  END IF;
  IF v_task.handoff_count >= 5 THEN
    RAISE EXCEPTION 'this card changed hands five times: a person has to look at it' USING ERRCODE = '23514';
  END IF;
  SELECT a.id INTO v_to FROM app.actors a WHERE a.id = p_to AND a.workspace_id = v_task.workspace_id AND a.kind <> 'system';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that is not an actor who can hold a card' USING ERRCODE = '23503';
  END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor AND NOT v_lead
     AND (SELECT a.kind FROM app.actors a WHERE a.id = v_actor) = 'person'
     AND p_to <> v_actor
     AND NOT EXISTS (SELECT 1 FROM app.actors b JOIN app.bots bt ON bt.id = b.ref_id AND bt.workspace_id = b.workspace_id
                      WHERE b.id = p_to AND b.kind = 'bot' AND bt.team_id = v_task.team_id) THEN
    RAISE EXCEPTION 'as the creator of an unowned card you can hand it to yourself or to a bot of this team; handing it to another person is for the owner or a lead' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.handoffs (task_id, team_id, from_actor_id, to_actor_id, mode, note)
  VALUES (p_task_id, v_task.team_id, v_actor, p_to, p_mode, left(coalesce(p_note, ''), 1000))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
