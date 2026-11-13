-- tasks 0017: a card's pull request (or GitLab merge request) may be one squashed commit made from the tested tree.
-- Why: the publish command now makes ONE commit per card (its author the bot account or the person who asked, its committer always the bot), so the commit
-- the request is at is no longer the commit that was tested. `p_squashed` says so: the check that the request's head starts with the tested commit is then
-- skipped, because the publish command (the only thing that can push a `card-<8>` branch) already refused to make a commit whose tree is not the tested one.
-- Everything else about the door is unchanged. The nine-argument form is replaced, not kept beside the new one.

DROP FUNCTION IF EXISTS app.tasks_record_pull_request(uuid, text, text, integer, text, text, text, text, text);

CREATE FUNCTION app.tasks_record_pull_request(
  p_task_id uuid, p_tested_sha text, p_project text, p_number integer, p_url text, p_origin text, p_head_ref text, p_head_sha text, p_base_ref text, p_squashed boolean DEFAULT false)
  RETURNS TABLE (o_outcome text, o_reason text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_head  text := lower(NULLIF(p_head_sha, ''));
  v_sha   text := lower(NULLIF(p_tested_sha, ''));
  v_chan  uuid;
  v_proj  text;
BEGIN
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, 'no such card'::text;
    RETURN;
  END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor AND NOT coalesce((SELECT app.lookup_can('team', v_task.team_id, 'manage')), false) THEN
    RETURN QUERY SELECT 'not_owner'::text, 'only the owner or a lead can record a pull request on this card'::text;
    RETURN;
  END IF;
  IF v_task.state = 'done' THEN
    RETURN QUERY SELECT 'already_done'::text, 'this card is already done'::text;
    RETURN;
  END IF;
  IF v_task.pull_request_state = 'open' THEN
    RETURN QUERY SELECT 'already_open'::text, format('pull request #%s is already open for this card', v_task.pull_request_number);
    RETURN;
  END IF;
  IF v_head IS NULL OR v_head !~ '^[0-9a-f]{7,64}$' OR v_sha IS NULL OR v_sha !~ '^[0-9a-f]{7,64}$' THEN
    RETURN QUERY SELECT 'tested_sha_required'::text, 'a pull request needs the commit that was tested'::text;
    RETURN;
  END IF;
  IF NOT coalesce(p_squashed, false) AND (left(v_head, length(v_sha)) <> v_sha OR (v_task.tested_sha IS NOT NULL AND left(v_head, length(v_task.tested_sha)) <> v_task.tested_sha)) THEN
    RETURN QUERY SELECT 'sha_mismatch'::text, 'the pull request is not at the commit that was tested'::text;
    RETURN;
  END IF;
  IF p_head_ref IS DISTINCT FROM 'card-' || left(p_task_id::text, 8) THEN
    RETURN QUERY SELECT 'wrong_branch'::text, 'a card''s pull request comes from its own branch, card-<first 8 characters of the card id>'::text;
    RETURN;
  END IF;
  IF p_project IS NULL OR p_project !~ '^[a-z0-9][a-z0-9._-]{0,60}$' OR p_number IS NULL OR p_number <= 0
     OR p_origin IS NULL OR length(p_origin) > 300 OR p_origin !~ '^https://[^/@?#[:space:]\\%]+(/[^/@?#[:space:]\\]+)*$'
     OR p_url IS NULL OR length(p_url) > 300 OR p_url !~ '^https://[^/@?#[:space:]\\%]+(/[^/@?#[:space:]\\]+)*$' THEN
    RETURN QUERY SELECT 'invalid_input'::text, 'the project, the pull request number and its https addresses are required'::text;
    RETURN;
  END IF;
  IF p_base_ref IS NULL OR length(p_base_ref) NOT BETWEEN 1 AND 100 THEN
    RETURN QUERY SELECT 'invalid_input'::text, 'the pull request needs the branch it is aimed at'::text;
    RETURN;
  END IF;
  -- The project must be the one this card is about: the project of the channel the card lives in (its board's channel, else its thread's channel);
  -- a card with no such link is bound to the project of its first pull request and may not name another one later.
  SELECT coalesce((SELECT b.channel_id FROM app.boards b WHERE b.id = v_task.board_id),
                  (SELECT m.channel_id FROM app.messages m WHERE m.id = v_task.thread_root_id)) INTO v_chan;
  IF v_chan IS NOT NULL THEN
    SELECT p.name INTO v_proj FROM app.projects p WHERE p.channel_id = v_chan AND p.team_id = v_task.team_id;
  END IF;
  IF (v_proj IS NOT NULL AND v_proj <> p_project) OR (v_task.pull_request_project IS NOT NULL AND v_task.pull_request_project <> p_project) THEN
    RETURN QUERY SELECT 'wrong_project'::text, 'this card is not about that project'::text;
    RETURN;
  END IF;
  UPDATE app.tasks
     SET tested_sha = v_head, state = 'waiting_on_person',
         blocker_reason = format('Pull request #%s waits for a person to merge it', p_number),
         pull_request_project = p_project, pull_request_number = p_number, pull_request_url = p_url, pull_request_origin = p_origin,
         pull_request_head_ref = p_head_ref, pull_request_head_sha = v_head, pull_request_base_ref = p_base_ref,
         pull_request_state = 'open', pull_request_merge_sha = NULL, pull_request_checked_at = NULL, updated_at = now()
   WHERE id = p_task_id;
  UPDATE app.task_claims SET released_at = now() WHERE task_id = p_task_id AND released_at IS NULL;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'pull_request_opened',
          jsonb_build_object('project', p_project, 'number', p_number, 'url', p_url, 'testedSha', v_head, 'from', v_task.state, 'to', 'waiting_on_person'));
  RETURN QUERY SELECT 'recorded'::text, ''::text;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_record_pull_request(uuid, text, text, integer, text, text, text, text, text, boolean) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_record_pull_request(uuid, text, text, integer, text, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_record_pull_request(uuid, text, text, integer, text, text, text, text, text, boolean) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.tasks_record_pull_request(uuid, text, text, integer, text, text, text, text, text, boolean) IS
  'The owner records the pull request it opened: the card gets the commit the request is at, waits on a person and its claim is released. p_squashed: the request is at one squashed commit, not at the tested commit itself.';

-- Whose name the published commit carries (tasks.commit_identity).
-- The owner of a card (or a lead of its team) asks, for the card's project: how the project signs commits (`bot` or `requester`) and, for `requester`, who that is:
-- the person who wrote the first message of the card's thread (else the person who created the card), with their display name and account email. Only the
-- owner or a lead can ask, so the email of a person reaches only the bot that is publishing their work, and only for a project that chose it. The project must be
-- the one this card is about (the same rule as tasks_record_pull_request). Outcomes: `ok`, `not_found`, `not_owner`, `wrong_project`, `no_requester`
-- (the project signs as the requester but no active person started the work).
CREATE FUNCTION app.tasks_commit_identity(p_task_id uuid, p_project text)
  RETURNS TABLE (o_outcome text, o_commit_as text, o_name text, o_email text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_chan  uuid;
  v_proj  record;
  v_from  uuid;
  v_person record;
BEGIN
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor AND NOT coalesce((SELECT app.lookup_can('team', v_task.team_id, 'manage')), false) THEN
    RETURN QUERY SELECT 'not_owner'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT p.name, p.commit_as INTO v_proj FROM app.projects p WHERE p.team_id = v_task.team_id AND p.name = p_project;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'wrong_project'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT coalesce((SELECT b.channel_id FROM app.boards b WHERE b.id = v_task.board_id),
                  (SELECT m.channel_id FROM app.messages m WHERE m.id = v_task.thread_root_id)) INTO v_chan;
  IF v_chan IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.projects p WHERE p.channel_id = v_chan AND p.team_id = v_task.team_id AND p.name = p_project) THEN
    RETURN QUERY SELECT 'wrong_project'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_proj.commit_as <> 'requester' THEN
    RETURN QUERY SELECT 'ok'::text, v_proj.commit_as, NULL::text, NULL::text;
    RETURN;
  END IF;
  -- the first message of the card's thread, else the card's creator: only a person counts
  v_from := coalesce((SELECT m.author_id FROM app.messages m WHERE m.id = v_task.thread_root_id), v_task.created_by);
  SELECT pe.display_name, pe.primary_email INTO v_person
    FROM app.actors a JOIN app.people pe ON pe.id = a.ref_id AND a.kind = 'person' AND pe.status = 'active'
   WHERE a.id = v_from;
  IF NOT FOUND OR v_person.primary_email IS NULL OR v_person.display_name IS NULL OR btrim(v_person.display_name) = '' THEN
    RETURN QUERY SELECT 'no_requester'::text, v_proj.commit_as, NULL::text, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text, v_proj.commit_as, v_person.display_name, v_person.primary_email;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_commit_identity(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_commit_identity(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_commit_identity(uuid, text) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.tasks_commit_identity(uuid, text) IS
  'The owner (or a lead) of a card asks how its project signs commits and, for a project that signs as the requester, the name and email of the person who started the work.';
