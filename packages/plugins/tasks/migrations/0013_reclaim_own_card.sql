-- tasks plugin 0013: the owner of a card may claim it again (live bug: the chain stalled on `tasks.describe` answering `claim_expired`).
-- A handover releases the claims and sets the new owner, so the bot that receives a card owns it and holds NO live claim; `tasks.claim`
-- answered `already_owned` even to that owner, and `tasks.describe` needs a live claim, so the receiving bot could never write the card.
-- Now a claim by the card's own owner makes a fresh claim (or answers the live one), and a claim that has already expired is released first so
-- the one-live-claim index lets the new one in. Anyone else is still refused. Forward-only; the signature and the grants are 0001's.

CREATE OR REPLACE FUNCTION app.tasks_claim(p_task_id uuid, p_ttl_seconds integer DEFAULT 3600)
  RETURNS TABLE (o_outcome text, o_owner_id uuid, o_expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_exp   timestamptz;
  v_live  timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'a claim needs a signed-in actor' USING ERRCODE = '42501';
  END IF;
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_task.owner_id IS NOT NULL AND v_task.owner_id IS DISTINCT FROM v_actor THEN
    RETURN QUERY SELECT 'already_owned'::text, v_task.owner_id, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_task.owner_id = v_actor THEN
    -- the owner asking again: a live claim is answered as before (`already_owned`, which the route and the tool turn into a no-op), otherwise a fresh one is made below
    SELECT c.expires_at INTO v_live FROM app.task_claims c WHERE c.task_id = p_task_id AND c.actor_id = v_actor AND c.released_at IS NULL AND c.expires_at > now();
    IF v_live IS NOT NULL THEN
      RETURN QUERY SELECT 'already_owned'::text, v_actor, NULL::timestamptz;
      RETURN;
    END IF;
    IF v_task.state NOT IN ('open', 'in_progress', 'verify') THEN
      RETURN QUERY SELECT 'not_claimable'::text, NULL::uuid, NULL::timestamptz;
      RETURN;
    END IF;
  ELSIF v_task.state NOT IN ('open', 'in_progress') THEN
    RETURN QUERY SELECT 'not_claimable'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  UPDATE app.task_claims SET released_at = now() WHERE task_id = p_task_id AND released_at IS NULL AND expires_at <= now();
  v_exp := now() + make_interval(secs => greatest(p_ttl_seconds, 60));
  UPDATE app.tasks SET owner_id = v_actor, state = CASE WHEN v_task.state = 'verify' THEN 'verify' ELSE 'in_progress' END, updated_at = now() WHERE id = p_task_id;
  INSERT INTO app.task_claims (task_id, team_id, actor_id, expires_at) VALUES (p_task_id, v_task.team_id, v_actor, v_exp);
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'claimed', jsonb_build_object('expiresAt', v_exp));
  RETURN QUERY SELECT 'claimed'::text, v_actor, v_exp;
END
$$;
