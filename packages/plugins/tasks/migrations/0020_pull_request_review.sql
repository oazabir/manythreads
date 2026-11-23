-- tasks plugin 0020: a person reviews a bot's pull request on its card (P35-02, docs/plans/review-in-thread.md). Forward-only: never edit once applied.
--
-- 1. `test_site_url`: the address where the card's tested commit runs (the team's test site today, a per-card one with P35-03), set by the card's owner
--    or a lead through `tasks_set_test_site` (the Deployer's `tasks.test_site`); https only, shown on the card next to the tested commit.
-- 2. `pull_request_reviewed` lines in the card's history: a lead approved the request, asked for changes, or asked for the merge, at a given head
--    commit. The comment of a change request is never in the line (it goes to the provider and to the bot as its hand-off note); `data` has the verdict,
--    the request's number and the head commit.
-- 3. `tasks_review_pull_request`: the one door of a decision. Only a lead of the card's team (or a workspace admin, `manage`), only while the request is
--    open and the card waits on a person, and only at the recorded head: a decision about a commit nobody tested is refused (P6-04).
-- 4. `tasks_merged_here`: a merge made from the card finishes it at once, through the sync's door.

ALTER TABLE app.tasks
  ADD COLUMN test_site_url text
    CHECK (test_site_url IS NULL OR (length(test_site_url) <= 300 AND test_site_url ~ '^https://[^/@?#[:space:]\\%]+(/[^@#[:space:]\\]*)?$'));

-- the thread's line "Pull request #N waits for review" reads the open requests of one thread
CREATE INDEX tasks_thread_open_pull_request ON app.tasks (thread_root_id) WHERE pull_request_state = 'open';

ALTER TABLE app.task_events DROP CONSTRAINT task_events_type_check;
ALTER TABLE app.task_events ADD CONSTRAINT task_events_type_check
  CHECK (type IN ('created', 'claimed', 'released', 'state_changed', 'handed_off', 'completed', 'reworked', 'deployed', 'not_woken',
                  'pull_request_opened', 'pull_request_closed', 'described', 'pull_request_reviewed', 'test_site'));

CREATE FUNCTION app.tasks_review_pull_request(p_task_id uuid, p_verdict text, p_head_sha text)
  RETURNS TABLE (o_outcome text, o_reason text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_head  text := lower(NULLIF(p_head_sha, ''));
BEGIN
  IF p_verdict IS NULL OR p_verdict NOT IN ('approved', 'changes_requested', 'merge_asked') THEN
    RETURN QUERY SELECT 'invalid_input'::text, 'the verdict is approved, changes_requested or merge_asked'::text;
    RETURN;
  END IF;
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, 'no such card'::text;
    RETURN;
  END IF;
  IF NOT coalesce((SELECT app.lookup_can('team', v_task.team_id, 'manage')), false) THEN
    RETURN QUERY SELECT 'not_lead'::text, 'only a lead of this team can approve, ask for changes or merge'::text;
    RETURN;
  END IF;
  IF v_task.pull_request_state IS DISTINCT FROM 'open' OR v_task.state <> 'waiting_on_person' THEN
    RETURN QUERY SELECT 'not_open'::text, 'this card has no open pull request waiting for a person'::text;
    RETURN;
  END IF;
  IF v_head IS NULL OR v_head !~ '^[0-9a-f]{7,64}$' OR v_head <> v_task.pull_request_head_sha THEN
    RETURN QUERY SELECT 'sha_mismatch'::text, format('the pull request is no longer at the tested commit %s', left(v_task.pull_request_head_sha, 12));
    RETURN;
  END IF;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'pull_request_reviewed',
          jsonb_build_object('verdict', p_verdict, 'pullRequest', v_task.pull_request_number, 'headSha', v_head));
  UPDATE app.tasks SET updated_at = now() WHERE id = p_task_id;
  RETURN QUERY SELECT 'recorded'::text, ''::text;
END
$$;

-- The address where the card's tested commit runs. The card's owner (the bot that deployed it) or a lead; null clears it.
CREATE FUNCTION app.tasks_set_test_site(p_task_id uuid, p_url text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_url   text := NULLIF(btrim(coalesce(p_url, '')), '');
BEGIN
  IF v_url IS NOT NULL AND (length(v_url) > 300 OR v_url !~ '^https://[^/@?#[:space:]\\%]+(/[^@#[:space:]\\]*)?$') THEN RETURN 'invalid_input'; END IF;
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor AND NOT coalesce((SELECT app.lookup_can('team', v_task.team_id, 'manage')), false) THEN RETURN 'not_owner'; END IF;
  IF v_task.state = 'done' THEN RETURN 'already_done'; END IF;
  UPDATE app.tasks SET test_site_url = v_url, updated_at = now() WHERE id = p_task_id;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'test_site', jsonb_build_object('url', v_url));
  RETURN 'recorded';
END
$$;

-- A lead merged the request from the card (the route asked the provider to merge at the recorded head and the provider said it did): the card is finished
-- at once through the sync's own door, instead of three minutes later. Only the lead who asked for the merge at that head in the last ten minutes
-- (`merge_asked`, written by `tasks_review_pull_request`), so the door cannot finish a card nobody merged.
CREATE FUNCTION app.tasks_merged_here(p_task_id uuid, p_merge_sha text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_out   text;
BEGIN
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]);
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF NOT coalesce((SELECT app.lookup_can('team', v_task.team_id, 'manage')), false) THEN RETURN 'not_lead'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.task_events e
     WHERE e.task_id = p_task_id AND e.actor_id = v_actor AND e.type = 'pull_request_reviewed' AND e.data->>'verdict' = 'merge_asked'
       AND e.data->>'headSha' = v_task.pull_request_head_sha AND e.created_at > now() - interval '10 minutes'
  ) THEN
    RETURN 'not_asked';
  END IF;
  SELECT o_outcome INTO v_out FROM app.tasks_resolve_pull_request(p_task_id, 'merged', p_merge_sha, '');
  IF v_out = 'merged' THEN PERFORM app.tasks_drop_private_notes(p_task_id); END IF;
  RETURN coalesce(v_out, 'not_open');
END
$$;

-- owned by the system role, as the other doors (0010): a definer function owned by the migration role would run with more than it needs
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_review_pull_request(uuid, text, text) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_set_test_site(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_merged_here(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

REVOKE ALL ON FUNCTION app.tasks_review_pull_request(uuid, text, text), app.tasks_set_test_site(uuid, text), app.tasks_merged_here(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_review_pull_request(uuid, text, text) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.tasks_set_test_site(uuid, text) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.tasks_merged_here(uuid, text) TO manythreads_app, manythreads_system;
