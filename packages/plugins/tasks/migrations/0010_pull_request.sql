-- tasks plugin 0010: a card can wait on a pull request that a person merges. Forward-only: never edit once applied.
--
-- When a project has a GitHub origin and a push credential, the tester's last step is no longer "complete the card": the tested branch is pushed to
-- the origin and a pull request is opened, and the person who merges it in GitHub is the approval. The card links the pull request, waits on a person
-- ("Pull request #N waits for a person to merge it") and follows the pull request: merged -> done (the merge commit goes in the card's history),
-- closed without a merge -> back to its owner with the reason.
--
-- Columns on app.tasks (all null while the card has no pull request, all set once it has one):
--   pull_request_project     the project's name on this team (the pod's token Secret is keyed by it)
--   pull_request_origin      the repository address the pull request was opened against, as the project's token was issued for it (the sync job
--                            asks that address and refuses a token that has since been issued for another one; tasks never reads the projects table)
--   pull_request_base_ref    the branch it is aimed at: the project's main branch (a pull request into any other branch is not an approval of the main line)
--   pull_request_head_ref    the branch the pull request comes from; always `card-<first 8 characters of the card id>`
--   pull_request_head_sha    the commit that branch was at when the pull request was recorded (the tested commit); a merge of any other commit is
--                            not a merge of what was tested
--   pull_request_number      the number GitHub gave it
--   pull_request_url         its address, for the board and the history
--   pull_request_state       open | merged | closed | withdrawn (the card moved on by another door, so the pull request is no longer followed)
--   pull_request_merge_sha   the commit the merge made, once merged
--   pull_request_checked_at  when the sync job last asked GitHub, so each card is asked in turn and a slow origin does not starve the others
--
-- Two doors: `tasks_record_pull_request` (called as the bot that opened it, through the `tasks.pull_request` tool) and
-- `tasks_resolve_pull_request` (only the system role may run it: the sync job reports what GitHub said). No token is stored anywhere here.

ALTER TABLE app.tasks
  ADD COLUMN pull_request_project text
    CHECK (pull_request_project IS NULL OR pull_request_project ~ '^[a-z0-9][a-z0-9._-]{0,60}$'),
  ADD COLUMN pull_request_origin text CHECK (pull_request_origin IS NULL OR length(pull_request_origin) <= 300),
  ADD COLUMN pull_request_head_ref text CHECK (pull_request_head_ref IS NULL OR pull_request_head_ref ~ '^card-[0-9a-f]{8}$'),
  ADD COLUMN pull_request_head_sha text CHECK (pull_request_head_sha IS NULL OR pull_request_head_sha ~ '^[0-9a-f]{7,64}$'),
  ADD COLUMN pull_request_base_ref text CHECK (pull_request_base_ref IS NULL OR length(pull_request_base_ref) BETWEEN 1 AND 100),
  ADD COLUMN pull_request_number integer CHECK (pull_request_number IS NULL OR pull_request_number > 0),
  ADD COLUMN pull_request_url text
    CHECK (pull_request_url IS NULL OR (length(pull_request_url) <= 300 AND pull_request_url ~ '^https://[^/@?#[:space:]\\%]+(/[^/@?#[:space:]\\]+)*$')),
  ADD COLUMN pull_request_state text CHECK (pull_request_state IS NULL OR pull_request_state IN ('open', 'merged', 'closed', 'withdrawn')),
  ADD COLUMN pull_request_merge_sha text CHECK (pull_request_merge_sha IS NULL OR pull_request_merge_sha ~ '^[0-9a-f]{7,64}$'),
  ADD COLUMN pull_request_checked_at timestamptz,
  ADD CONSTRAINT tasks_pull_request_whole CHECK (
    (pull_request_project IS NULL AND pull_request_number IS NULL AND pull_request_url IS NULL AND pull_request_state IS NULL
       AND pull_request_origin IS NULL AND pull_request_head_ref IS NULL AND pull_request_head_sha IS NULL AND pull_request_base_ref IS NULL)
    OR (pull_request_project IS NOT NULL AND pull_request_number IS NOT NULL AND pull_request_url IS NOT NULL AND pull_request_state IS NOT NULL
       AND pull_request_origin IS NOT NULL AND pull_request_head_ref IS NOT NULL AND pull_request_head_sha IS NOT NULL AND pull_request_base_ref IS NOT NULL)
  );

-- the sync job's work list: open pull requests, least recently asked first
CREATE INDEX tasks_pull_request_open ON app.tasks (pull_request_checked_at NULLS FIRST, id) WHERE pull_request_state = 'open';

ALTER TABLE app.task_events DROP CONSTRAINT task_events_type_check;
ALTER TABLE app.task_events ADD CONSTRAINT task_events_type_check
  CHECK (type IN ('created', 'claimed', 'released', 'state_changed', 'handed_off', 'completed', 'reworked', 'deployed', 'not_woken',
                  'pull_request_opened', 'pull_request_closed'));

-- A card that leaves `waiting_on_person` by any door (a completion, a board move, a handover, a sweep) stops following its pull request: the
-- tracking is closed out as `withdrawn` in the same statement, so the sync job never acts on a card that moved on without it.
CREATE FUNCTION app.tasks_withdraw_pull_request() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.pull_request_state = 'open' AND NEW.pull_request_state = 'open' AND NEW.state <> 'waiting_on_person' THEN
    NEW.pull_request_state := 'withdrawn';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tasks_withdraw_pull_request BEFORE UPDATE OF state ON app.tasks
  FOR EACH ROW EXECUTE FUNCTION app.tasks_withdraw_pull_request();

-- Record the pull request a bot opened for its card. The tool has already checked with GitHub (using the project's own token) that the pull request is
-- open, comes from `card-<8>` of this very repository at the head commit named here, and is aimed at the same repository; the address is made by the
-- server from the origin and the number, never taken from the bot. The caller must own the card (or lead its team). The head commit becomes the card's
-- tested commit (a done card needs one), the live claim is released (a sweep must not reopen a card that waits on a person) and the card waits.
CREATE FUNCTION app.tasks_record_pull_request(
  p_task_id uuid, p_tested_sha text, p_project text, p_number integer, p_url text, p_origin text, p_head_ref text, p_head_sha text, p_base_ref text)
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
  IF left(v_head, length(v_sha)) <> v_sha OR (v_task.tested_sha IS NOT NULL AND left(v_head, length(v_task.tested_sha)) <> v_task.tested_sha) THEN
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

-- What GitHub said about an open pull request (the sync job has already checked that it is still the recorded branch at the recorded commit), applied
-- once. The card changes only while it is still `waiting_on_person` and the pull request is still the open one recorded: merged -> done with the merge
-- commit in the history; closed -> back to its owner with the reason and a live claim, so it can go on. For a card that moved on, the pull request's
-- final state is recorded and nothing else changes (no second `completed` line, no reopening a done card). Only the system role may run it.
CREATE FUNCTION app.tasks_resolve_pull_request(p_task_id uuid, p_outcome text, p_merge_sha text, p_reason text)
  RETURNS TABLE (o_outcome text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_task record;
  v_sha  text := lower(NULLIF(p_merge_sha, ''));
  v_why  text;
BEGIN
  IF p_outcome NOT IN ('merged', 'closed') THEN
    RAISE EXCEPTION 'outcome is merged or closed' USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.pull_request_state = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_open'::text;
    RETURN;
  END IF;
  IF v_sha IS NOT NULL AND v_sha !~ '^[0-9a-f]{7,64}$' THEN v_sha := NULL; END IF;
  IF v_task.state <> 'waiting_on_person' THEN
    -- the card moved on by itself: only the pull request's own record changes
    UPDATE app.tasks SET pull_request_state = p_outcome, pull_request_merge_sha = CASE WHEN p_outcome = 'merged' THEN v_sha ELSE NULL END,
           pull_request_checked_at = now() WHERE id = p_task_id;
    RETURN QUERY SELECT 'recorded_only'::text;
    RETURN;
  END IF;
  IF p_outcome = 'merged' THEN
    UPDATE app.tasks
       SET state = 'done', completed_at = now(), blocker_reason = '', pull_request_state = 'merged', pull_request_merge_sha = v_sha,
           pull_request_checked_at = now(), updated_at = now()
     WHERE id = p_task_id;
    UPDATE app.task_claims SET released_at = now() WHERE task_id = p_task_id AND released_at IS NULL;
    INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
    VALUES (p_task_id, v_task.team_id, NULL, 'completed',
            jsonb_build_object('from', v_task.state, 'to', 'done', 'testedSha', v_task.tested_sha, 'pullRequest', v_task.pull_request_number, 'mergeSha', v_sha));
    RETURN QUERY SELECT 'merged'::text;
  ELSE
    v_why := left(coalesce(NULLIF(p_reason, ''), format('Pull request #%s was closed without being merged', v_task.pull_request_number)), 500);
    UPDATE app.tasks
       SET state = CASE WHEN owner_id IS NULL THEN 'open' ELSE 'in_progress' END, blocker_reason = v_why,
           pull_request_state = 'closed', pull_request_checked_at = now(), completed_at = NULL, updated_at = now()
     WHERE id = p_task_id;
    -- the owner can go on at once: a live claim, as if it had just claimed the card again
    IF v_task.owner_id IS NOT NULL THEN
      INSERT INTO app.task_claims (task_id, team_id, actor_id, expires_at) VALUES (p_task_id, v_task.team_id, v_task.owner_id, now() + interval '1 hour');
    END IF;
    INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
    VALUES (p_task_id, v_task.team_id, NULL, 'pull_request_closed',
            jsonb_build_object('from', v_task.state, 'to', CASE WHEN v_task.owner_id IS NULL THEN 'open' ELSE 'in_progress' END,
                               'pullRequest', v_task.pull_request_number, 'reason', v_why));
    RETURN QUERY SELECT 'closed'::text;
  END IF;
END
$$;

-- tasks_complete and tasks_move (0001), with one added refusal each: a bot cannot finish a card around its open pull request.
CREATE OR REPLACE FUNCTION app.tasks_complete(p_task_id uuid, p_tested_sha text, p_branch_head_sha text)
  RETURNS TABLE (o_outcome text, o_reason text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_sha   text := NULLIF(p_tested_sha, '');
BEGIN
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, 'no such card'::text;
    RETURN;
  END IF;
  -- while a pull request waits to be merged, the merge is the gate: a bot cannot finish the card around it (a person still can, by hand)
  IF v_task.pull_request_state = 'open' AND coalesce((SELECT a.kind = 'bot' FROM app.actors a WHERE a.id = v_actor), false) THEN
    RETURN QUERY SELECT 'waiting_on_merge'::text, 'a pull request is open for this card: a person merges it, and the card is finished by the merge'::text;
    RETURN;
  END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor THEN
    RETURN QUERY SELECT 'not_owner'::text, 'only the owner can complete this card'::text;
    RETURN;
  END IF;
  IF v_sha IS NULL THEN v_sha := v_task.tested_sha; END IF;
  IF v_task.kind = 'code' AND v_sha IS NULL THEN
    RETURN QUERY SELECT 'tested_sha_required'::text, 'a code card cannot be done without the commit that was tested'::text;
    RETURN;
  END IF;
  IF p_branch_head_sha IS NOT NULL AND v_task.base_sha IS NOT NULL AND p_branch_head_sha <> v_task.base_sha THEN
    -- The reason goes on the card, so the board can show it without re-running the check.
    UPDATE app.tasks
       SET blocker_reason = format('base_sha is %s, the branch head is %s: rebase and test again', left(v_task.base_sha, 8), left(p_branch_head_sha, 8)),
           updated_at = now()
     WHERE id = p_task_id;
    RETURN QUERY SELECT 'stale_base'::text,
      format('base_sha is %s, the branch head is %s: rebase and test again', left(v_task.base_sha, 8), left(p_branch_head_sha, 8));
    RETURN;
  END IF;
  UPDATE app.tasks
     SET state = 'done', tested_sha = v_sha, completed_at = now(), blocker_reason = '', updated_at = now()
   WHERE id = p_task_id;
  UPDATE app.task_claims SET released_at = now() WHERE task_id = p_task_id AND released_at IS NULL;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'completed', jsonb_build_object('testedSha', v_sha));
  RETURN QUERY SELECT 'done'::text, ''::text;
END
$$;

CREATE OR REPLACE FUNCTION app.tasks_move(p_task_id uuid, p_to text)
  RETURNS TABLE (o_outcome text, o_reason text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_ok    boolean;
BEGIN
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, 'no such card'::text;
    RETURN;
  END IF;
  v_ok := CASE v_task.state
    WHEN 'open' THEN p_to IN ('in_progress', 'done')
    WHEN 'in_progress' THEN p_to IN ('verify', 'waiting_on_person', 'open', 'done')
    WHEN 'verify' THEN p_to IN ('in_progress', 'waiting_on_person', 'done')
    WHEN 'waiting_on_person' THEN p_to IN ('in_progress', 'verify', 'open')
    ELSE false
  END;
  IF p_to = 'done' AND v_task.pull_request_state = 'open' AND coalesce((SELECT a.kind = 'bot' FROM app.actors a WHERE a.id = v_actor), false) THEN
    RETURN QUERY SELECT 'waiting_on_merge'::text, 'a pull request is open for this card: a person merges it, and the card is finished by the merge'::text;
    RETURN;
  END IF;
  IF NOT v_ok THEN
    RETURN QUERY SELECT 'invalid_transition'::text, format('%s cannot move to %s', v_task.state, p_to);
    RETURN;
  END IF;
  IF p_to = 'done' AND v_task.kind = 'code' AND v_task.tested_sha IS NULL THEN
    RETURN QUERY SELECT 'tested_sha_required'::text, 'a code card cannot be done without the commit that was tested'::text;
    RETURN;
  END IF;
  UPDATE app.tasks
     SET state = p_to,
         completed_at = CASE WHEN p_to = 'done' THEN now() ELSE NULL END,
         blocker_reason = CASE WHEN p_to = 'waiting_on_person' THEN coalesce(nullif(v_task.blocker_reason, ''), 'waiting on a person') ELSE '' END,
         updated_at = now()
   WHERE id = p_task_id;
  IF p_to = 'done' THEN
    UPDATE app.task_claims SET released_at = now() WHERE task_id = p_task_id AND released_at IS NULL;
  END IF;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, CASE WHEN p_to = 'done' THEN 'completed' ELSE 'state_changed' END,
          jsonb_build_object('from', v_task.state, 'to', p_to));
  RETURN QUERY SELECT 'moved'::text, ''::text;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_record_pull_request(uuid, text, text, integer, text, text, text, text, text) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_resolve_pull_request(uuid, text, text, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

REVOKE ALL ON FUNCTION app.tasks_record_pull_request(uuid, text, text, integer, text, text, text, text, text), app.tasks_resolve_pull_request(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_record_pull_request(uuid, text, text, integer, text, text, text, text, text) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.tasks_resolve_pull_request(uuid, text, text, text) TO manythreads_system;

COMMENT ON FUNCTION app.tasks_record_pull_request(uuid, text, text, integer, text, text, text, text, text) IS
  'The owner records the pull request it opened: the card gets the tested commit, waits on a person and its claim is released.';
COMMENT ON FUNCTION app.tasks_resolve_pull_request(uuid, text, text, text) IS
  'System only: an open pull request was merged (card done, merge commit in history) or closed (card back to its owner with the reason).';
