-- tasks plugin 0001 (PLAN P6-01 … P6-05; SPEC §8, §7.6). Forward-only: never edit once applied.
--
--  * goals, tasks, task_claims, task_events, handoffs, environments, deploys, boards, runners. Every table carries team_id
--    for a hoisted read policy (`team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])`), and every foreign key is indexed.
--  * One live claim per card: a partial unique index on task_claims (task_id) WHERE released_at IS NULL, so two concurrent
--    claims cannot both win — the loser's UPDATE finds owner_id set and the INSERT hits the index.
--  * The doors below are SECURITY DEFINER, owned by manythreads_system (current_user is the function owner, so app.is_system()
--    is true inside them): claim, release, complete (the freshness gate), handoff, apply a strict handoff after its approval,
--    rework, a board move, the claim sweep and the deploy checks. They check the caller themselves; the app role has no DML
--    on task_claims, task_events, handoffs and deploys.
--  * Freshness (P6-04): a `code` card cannot reach done without tested_sha, and a complete whose base_sha differs from the
--    branch head the caller names is refused with the reason. Rework and handoff counts are bounded.
--  * Environments (P6-05): `protected` (or `needs_approval`) makes a deploy wait for a person other than the requester; the
--    daily cap and the deploy windows are checked here, in one place.

-- goals (T) -------------------------------------------------------------------------------------------------
CREATE TABLE app.goals (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  created_by   uuid NOT NULL REFERENCES app.actors (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX goals_team ON app.goals (team_id);
CREATE INDEX goals_workspace ON app.goals (workspace_id);
CREATE INDEX goals_open ON app.goals (team_id, created_at DESC) WHERE status = 'open';
COMMENT ON TABLE app.goals IS 'rls: team — T: goals of the teams the caller can read; written by team writers.';

ALTER TABLE app.goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.goals FORCE ROW LEVEL SECURITY;
CREATE POLICY goals_select ON app.goals FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY goals_insert ON app.goals FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) AND created_by = (SELECT app.actor()))
);
CREATE POLICY goals_update ON app.goals FOR UPDATE USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])
) WITH CHECK (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])
);
CREATE POLICY goals_delete ON app.goals FOR DELETE USING ((SELECT app.is_system()));

-- environments (T) -------------------------------------------------------------------------------------------
CREATE TABLE app.environments (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,39}$'),
  protected      boolean NOT NULL DEFAULT false,
  needs_approval boolean NOT NULL DEFAULT false,
  windows        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(windows) = 'array'),
  deploy_cap     integer CHECK (deploy_cap IS NULL OR deploy_cap > 0),
  auto_rollback  boolean NOT NULL DEFAULT true,
  credential_ref text NOT NULL DEFAULT '' CHECK (char_length(credential_ref) <= 200),
  created_by     uuid NOT NULL REFERENCES app.actors (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);
CREATE INDEX environments_team ON app.environments (team_id);
CREATE INDEX environments_workspace ON app.environments (workspace_id);
COMMENT ON TABLE app.environments IS 'rls: team — T: deploy environments; `protected`/`needs_approval` gate deploys through one approval.';

ALTER TABLE app.environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.environments FORCE ROW LEVEL SECURITY;
CREATE POLICY environments_select ON app.environments FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY environments_insert ON app.environments FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]) AND created_by = (SELECT app.actor()))
);
CREATE POLICY environments_update ON app.environments FOR UPDATE USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
) WITH CHECK (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
);
CREATE POLICY environments_delete ON app.environments FOR DELETE USING ((SELECT app.is_system()));

-- tasks (T) --------------------------------------------------------------------------------------------------
CREATE TABLE app.tasks (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  goal_id         uuid REFERENCES app.goals (id) ON DELETE SET NULL,
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description     text NOT NULL DEFAULT '' CHECK (char_length(description) <= 8000),
  state           text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'in_progress', 'verify', 'waiting_on_person', 'done')),
  kind            text NOT NULL DEFAULT 'code' CHECK (kind IN ('code', 'content', 'ops', 'other')),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  owner_id        uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  branch          text NOT NULL CHECK (char_length(branch) BETWEEN 1 AND 200),
  base_sha        text CHECK (base_sha IS NULL OR base_sha ~ '^[0-9a-f]{7,64}$'),
  tested_sha      text CHECK (tested_sha IS NULL OR tested_sha ~ '^[0-9a-f]{7,64}$'),
  environment_id  uuid REFERENCES app.environments (id) ON DELETE SET NULL,
  thread_root_id  uuid,
  blocker_reason  text NOT NULL DEFAULT '' CHECK (char_length(blocker_reason) <= 500),
  rework_count    integer NOT NULL DEFAULT 0 CHECK (rework_count >= 0),
  handoff_count   integer NOT NULL DEFAULT 0 CHECK (handoff_count >= 0),
  created_by      uuid NOT NULL REFERENCES app.actors (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  -- A finished card is either a non-code card or one with the commit that was tested.
  CONSTRAINT tasks_done_is_tested CHECK (state <> 'done' OR kind <> 'code' OR tested_sha IS NOT NULL)
);
CREATE INDEX tasks_team ON app.tasks (team_id);
CREATE INDEX tasks_workspace ON app.tasks (workspace_id);
CREATE INDEX tasks_owner ON app.tasks (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX tasks_goal ON app.tasks (goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX tasks_environment ON app.tasks (environment_id) WHERE environment_id IS NOT NULL;
-- the board and the open-card list read this one; done cards are history
CREATE INDEX tasks_open_by_team ON app.tasks (team_id, state, id DESC) WHERE state <> 'done';
CREATE INDEX tasks_team_updated ON app.tasks (team_id, updated_at DESC);
COMMENT ON TABLE app.tasks IS 'rls: team — T: the task board; one owner at a time, one live claim per card; `tasks_done_is_tested` is the freshness rule.';

ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_select ON app.tasks FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY tasks_insert ON app.tasks FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) AND created_by = (SELECT app.actor()))
);
CREATE POLICY tasks_update ON app.tasks FOR UPDATE USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])
) WITH CHECK (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])
);
CREATE POLICY tasks_delete ON app.tasks FOR DELETE USING ((SELECT app.is_system()));

-- task_claims (T): one live claim per card ------------------------------------------------------------------
CREATE TABLE app.task_claims (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  task_id     uuid NOT NULL REFERENCES app.tasks (id) ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  actor_id    uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  released_at timestamptz
);
CREATE UNIQUE INDEX task_claims_live ON app.task_claims (task_id) WHERE released_at IS NULL;
CREATE INDEX task_claims_actor ON app.task_claims (actor_id);
CREATE INDEX task_claims_team ON app.task_claims (team_id);
CREATE INDEX task_claims_expiry ON app.task_claims (expires_at) WHERE released_at IS NULL;
COMMENT ON TABLE app.task_claims IS 'rls: team — T: live claims (one per card, `task_claims_live`); the app role reads them, only the doors below write.';

ALTER TABLE app.task_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY task_claims_select ON app.task_claims FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY task_claims_system ON app.task_claims FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- task_events (T): append-only history ---------------------------------------------------------------
CREATE TABLE app.task_events (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  task_id    uuid NOT NULL REFERENCES app.tasks (id) ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  type       text NOT NULL CHECK (type IN ('created', 'claimed', 'released', 'state_changed', 'handed_off', 'completed', 'reworked', 'deployed')),
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task ON app.task_events (task_id, id);
CREATE INDEX task_events_team ON app.task_events (team_id);
CREATE INDEX task_events_created_brin ON app.task_events USING brin (created_at);
COMMENT ON TABLE app.task_events IS 'rls: team — T: append-only card history (BRIN on created_at); written only by the doors below.';

ALTER TABLE app.task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_events FORCE ROW LEVEL SECURITY;
CREATE POLICY task_events_select ON app.task_events FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY task_events_system ON app.task_events FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- handoffs (T) -----------------------------------------------------------------------------------------------
CREATE TABLE app.handoffs (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  task_id       uuid NOT NULL REFERENCES app.tasks (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  from_actor_id uuid NOT NULL REFERENCES app.actors (id),
  to_actor_id   uuid NOT NULL REFERENCES app.actors (id),
  mode          text NOT NULL CHECK (mode IN ('bot', 'person')),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  approval_id   uuid REFERENCES app.approvals (id) ON DELETE SET NULL,
  applied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handoffs_task ON app.handoffs (task_id, id);
CREATE INDEX handoffs_team ON app.handoffs (team_id);
CREATE INDEX handoffs_from ON app.handoffs (from_actor_id);
CREATE INDEX handoffs_to ON app.handoffs (to_actor_id);
CREATE INDEX handoffs_pending_approval ON app.handoffs (approval_id) WHERE applied_at IS NULL AND approval_id IS NOT NULL;
COMMENT ON TABLE app.handoffs IS 'rls: team — T: handovers; a `dispatch: strict` row waits (applied_at null) for its approval.';

ALTER TABLE app.handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY handoffs_select ON app.handoffs FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY handoffs_system ON app.handoffs FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- deploy_requests (T): the approval a protected deploy waits on, and the deploy it becomes ------------------
CREATE TABLE app.deploy_requests (
  approval_id    uuid PRIMARY KEY REFERENCES app.approvals (id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  environment_id uuid NOT NULL REFERENCES app.environments (id) ON DELETE CASCADE,
  task_id        uuid REFERENCES app.tasks (id) ON DELETE SET NULL,
  actor_id       uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  applied_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deploy_requests_team ON app.deploy_requests (team_id);
CREATE INDEX deploy_requests_environment ON app.deploy_requests (environment_id);
CREATE INDEX deploy_requests_pending ON app.deploy_requests (approval_id) WHERE applied_at IS NULL;
COMMENT ON TABLE app.deploy_requests IS 'rls: team — T: a protected deploy waiting for approval; approving it records the deploy exactly once.';

ALTER TABLE app.deploy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deploy_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY deploy_requests_select ON app.deploy_requests FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY deploy_requests_system ON app.deploy_requests FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- deploys (T): the daily cap's ledger --------------------------------------------------------------------
CREATE TABLE app.deploys (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  environment_id uuid NOT NULL REFERENCES app.environments (id) ON DELETE CASCADE,
  task_id        uuid REFERENCES app.tasks (id) ON DELETE SET NULL,
  actor_id       uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deploys_environment_day ON app.deploys (environment_id, created_at DESC);
CREATE INDEX deploys_team ON app.deploys (team_id);
CREATE INDEX deploys_created_brin ON app.deploys USING brin (created_at);
COMMENT ON TABLE app.deploys IS 'rls: team — T: one row per deploy, what the daily cap counts.';

ALTER TABLE app.deploys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deploys FORCE ROW LEVEL SECURITY;
CREATE POLICY deploys_select ON app.deploys FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY deploys_system ON app.deploys FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- boards (T) -------------------------------------------------------------------------------------------------
CREATE TABLE app.boards (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  columns      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(columns) = 'array'),
  filter       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filter) = 'object'),
  created_by   uuid NOT NULL REFERENCES app.actors (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boards_team ON app.boards (team_id);
CREATE INDEX boards_workspace ON app.boards (workspace_id);
COMMENT ON TABLE app.boards IS 'rls: team — T: saved board views; a drag goes through app.tasks_move, never a direct write.';

ALTER TABLE app.boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.boards FORCE ROW LEVEL SECURITY;
CREATE POLICY boards_select ON app.boards FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY boards_insert ON app.boards FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) AND created_by = (SELECT app.actor()))
);
CREATE POLICY boards_update ON app.boards FOR UPDATE USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])
) WITH CHECK (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])
);
CREATE POLICY boards_delete ON app.boards FOR DELETE USING ((SELECT app.is_system()));

-- runners (T) ------------------------------------------------------------------------------------------------
CREATE TABLE app.runners (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  capabilities  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array'),
  status        text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'offline')),
  last_seen_at  timestamptz,
  registered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);
CREATE INDEX runners_team ON app.runners (team_id);
CREATE INDEX runners_workspace ON app.runners (workspace_id);
CREATE INDEX runners_online ON app.runners (team_id, last_seen_at DESC) WHERE status = 'online';
COMMENT ON TABLE app.runners IS 'rls: team — T: runner processes and what they can do (`placement.node` matching).';

ALTER TABLE app.runners ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.runners FORCE ROW LEVEL SECURITY;
CREATE POLICY runners_select ON app.runners FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY runners_insert ON app.runners FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
);
CREATE POLICY runners_update ON app.runners FOR UPDATE USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
) WITH CHECK (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
);
CREATE POLICY runners_delete ON app.runners FOR DELETE USING ((SELECT app.is_system()));

-- Privileges: least privilege. Claims, events, handoffs and deploys are written by the doors only. ---------------------------
GRANT SELECT, INSERT, UPDATE ON app.goals, app.tasks, app.environments, app.boards TO manythreads_app;
GRANT DELETE ON app.goals, app.tasks, app.environments, app.boards TO manythreads_app;
GRANT SELECT ON app.task_claims, app.task_events, app.handoffs, app.deploy_requests, app.deploys TO manythreads_app;
GRANT SELECT, INSERT, UPDATE ON app.runners TO manythreads_app;
GRANT DELETE ON app.runners TO manythreads_app;

-- The doors ----------------------------------------------------------------------------------------------------
-- Claim: one live claim per card. The UPDATE only matches while nobody owns the card, and the partial unique index on
-- task_claims makes a second claim fail even if two transactions read "no owner" at the same time.
CREATE FUNCTION app.tasks_claim(p_task_id uuid, p_ttl_seconds integer DEFAULT 3600)
  RETURNS TABLE (o_outcome text, o_owner_id uuid, o_expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_exp   timestamptz;
  v_owner_name text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'a claim needs a signed-in actor' USING ERRCODE = '42501';
  END IF;
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_task.owner_id IS NOT NULL THEN
    RETURN QUERY SELECT 'already_owned'::text, v_task.owner_id, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_task.state NOT IN ('open', 'in_progress') THEN
    RETURN QUERY SELECT 'not_claimable'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  v_exp := now() + make_interval(secs => greatest(p_ttl_seconds, 60));
  UPDATE app.tasks SET owner_id = v_actor, state = 'in_progress', updated_at = now() WHERE id = p_task_id;
  INSERT INTO app.task_claims (task_id, team_id, actor_id, expires_at) VALUES (p_task_id, v_task.team_id, v_actor, v_exp);
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'claimed', jsonb_build_object('expiresAt', v_exp));
  RETURN QUERY SELECT 'claimed'::text, v_actor, v_exp;
END
$$;

-- Release: the owner gives the card back; a lead may take it away from a stale owner.
CREATE FUNCTION app.tasks_release(p_task_id uuid)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
BEGIN
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor
     AND NOT (SELECT app.lookup_can('team', v_task.team_id, 'manage')) THEN
    RETURN 'not_owner';
  END IF;
  UPDATE app.task_claims SET released_at = now() WHERE task_id = p_task_id AND released_at IS NULL;
  UPDATE app.tasks SET owner_id = NULL, state = 'open', updated_at = now() WHERE id = p_task_id;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data) VALUES (p_task_id, v_task.team_id, v_actor, 'released', '{}'::jsonb);
  RETURN 'released';
END
$$;

-- Complete: the freshness gate. A code card needs a tested sha; a base that moved is refused with the reason.
CREATE FUNCTION app.tasks_complete(p_task_id uuid, p_tested_sha text, p_branch_head_sha text)
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

-- Handoff: one transaction, the old owner loses the card and its claim in the same statement as the new owner gains it.
CREATE FUNCTION app.tasks_handoff(p_task_id uuid, p_to uuid, p_mode text, p_note text, p_approval uuid)
  RETURNS TABLE (o_outcome text, o_handoff_id uuid, o_reason text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_to    record;
  v_id    uuid;
  v_state text;
BEGIN
  IF p_mode NOT IN ('bot', 'person') THEN
    RAISE EXCEPTION 'mode is bot or person' USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, 'no such card'::text;
    RETURN;
  END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor
     AND NOT (SELECT app.lookup_can('team', v_task.team_id, 'manage')) THEN
    RETURN QUERY SELECT 'not_owner'::text, NULL::uuid, 'only the owner or a lead can hand this card over'::text;
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

-- After a strict handoff's approval: the card moves. Exactly once (the handoff row's applied_at is the latch).
CREATE FUNCTION app.tasks_apply_handoff(p_approval_id uuid)
  RETURNS TABLE (o_handoff_id uuid, o_task_id uuid, o_team_id uuid, o_workspace_id uuid, o_from uuid, o_to uuid, o_mode text, o_note text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_h record;
  v_t record;
  v_state text;
BEGIN
  SELECT h.* INTO v_h FROM app.handoffs h WHERE h.approval_id = p_approval_id AND h.applied_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT t.* INTO v_t FROM app.tasks t WHERE t.id = v_h.task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_state := CASE WHEN v_h.mode = 'person' THEN 'waiting_on_person' ELSE 'in_progress' END;
  UPDATE app.task_claims SET released_at = now() WHERE task_id = v_h.task_id AND released_at IS NULL;
  UPDATE app.tasks
     SET owner_id = v_h.to_actor_id, state = v_state, handoff_count = handoff_count + 1,
         blocker_reason = CASE WHEN v_state = 'waiting_on_person' THEN coalesce(nullif(v_h.note, ''), 'waiting on a person') ELSE '' END,
         updated_at = now()
   WHERE id = v_h.task_id;
  UPDATE app.handoffs SET applied_at = now() WHERE id = v_h.id;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (v_h.task_id, v_h.team_id, NULL, 'handed_off',
          jsonb_build_object('handoffId', v_h.id, 'fromActorId', v_h.from_actor_id, 'toActorId', v_h.to_actor_id, 'mode', v_h.mode, 'approvalId', p_approval_id));
  RETURN QUERY SELECT v_h.id, v_h.task_id, v_h.team_id, v_t.workspace_id, v_h.from_actor_id, v_h.to_actor_id, v_h.mode, v_h.note;
END
$$;

-- A strict handoff, filed but not applied: the card does not move until the approval is approved.
CREATE FUNCTION app.tasks_handoff_pending(p_task_id uuid, p_to uuid, p_mode text, p_note text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_to    record;
  v_id    uuid;
BEGIN
  IF p_mode NOT IN ('bot', 'person') THEN
    RAISE EXCEPTION 'mode is bot or person' USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO v_task FROM app.tasks t
   WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such card' USING ERRCODE = '23503';
  END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor
     AND NOT (SELECT app.lookup_can('team', v_task.team_id, 'manage')) THEN
    RAISE EXCEPTION 'only the owner or a lead can hand this card over' USING ERRCODE = '42501';
  END IF;
  IF v_task.handoff_count >= 5 THEN
    RAISE EXCEPTION 'this card changed hands five times: a person has to look at it' USING ERRCODE = '23514';
  END IF;
  SELECT a.id INTO v_to FROM app.actors a WHERE a.id = p_to AND a.workspace_id = v_task.workspace_id AND a.kind <> 'system';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that is not an actor who can hold a card' USING ERRCODE = '23503';
  END IF;
  INSERT INTO app.handoffs (task_id, team_id, from_actor_id, to_actor_id, mode, note)
  VALUES (p_task_id, v_task.team_id, v_actor, p_to, p_mode, left(coalesce(p_note, ''), 1000))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Tie a filed handoff to the approval that decides it.
CREATE FUNCTION app.tasks_attach_approval(p_handoff_id uuid, p_approval_id uuid) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$ UPDATE app.handoffs SET approval_id = p_approval_id WHERE id = p_handoff_id AND applied_at IS NULL $$;

-- A deploy through an environment: the checks first, then (for a protected one) the approval that waits.
CREATE FUNCTION app.tasks_deploy_request(p_environment_id uuid, p_task_id uuid, p_note text)
  RETURNS TABLE (o_outcome text, o_reason text, o_approval_id uuid, o_deploy_id bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor   uuid := app.actor();
  v_check   record;
  v_env     record;
  v_approval uuid;
  v_deploy  bigint;
  v_ws      uuid := app.workspace_id();
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
    v_approval := app.approvals_request_task(
      v_env.workspace_id, v_env.team_id, coalesce(v_actor, v_env.created_by), 'environment', 'tasks.deploy',
      format('Deploy to %s', v_env.name),
      jsonb_build_object('kind', 'handoff', 'op', 'deploy', 'environmentId', v_env.id, 'taskId', p_task_id, 'note', left(coalesce(p_note, ''), 300)),
      NULL);
    INSERT INTO app.deploy_requests (approval_id, workspace_id, team_id, environment_id, task_id, actor_id, note)
    VALUES (v_approval, v_env.workspace_id, v_env.team_id, v_env.id, p_task_id, v_actor, left(coalesce(p_note, ''), 300));
    RETURN QUERY SELECT 'needs_approval'::text, v_check.o_reason, v_approval, NULL::bigint;
    RETURN;
  END IF;
  v_deploy := app.tasks_record_deploy(p_environment_id, p_task_id, v_actor, p_note);
  RETURN QUERY SELECT 'deployed'::text, ''::text, NULL::uuid, v_deploy;
END
$$;

-- Apply the deploy an approved request waited on (once: the request row's applied_at is the latch).
CREATE FUNCTION app.tasks_apply_deploy(p_approval_id uuid)
  RETURNS TABLE (o_team_id uuid, o_environment_id uuid, o_task_id uuid, o_actor_id uuid, o_note text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_req record;
BEGIN
  SELECT r.* INTO v_req FROM app.deploy_requests r WHERE r.approval_id = p_approval_id AND r.applied_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM app.tasks_record_deploy(v_req.environment_id, v_req.task_id, v_req.actor_id, v_req.note);
  UPDATE app.deploy_requests SET applied_at = now() WHERE approval_id = p_approval_id;
  RETURN QUERY SELECT v_req.team_id, v_req.environment_id, v_req.task_id, v_req.actor_id, v_req.note;
END
$$;

-- Rework: send the work back, count it, and stop at the bound.
CREATE FUNCTION app.tasks_rework(p_task_id uuid, p_reason text)
  RETURNS TABLE (o_outcome text, o_reason text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
BEGIN
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, 'no such card'::text;
    RETURN;
  END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor THEN
    RETURN QUERY SELECT 'not_owner'::text, 'only the owner can send this card back'::text;
    RETURN;
  END IF;
  IF v_task.rework_count >= 3 THEN
    RETURN QUERY SELECT 'rework_bound'::text, 'this work was sent back three times: a person has to look at it'::text;
    RETURN;
  END IF;
  UPDATE app.tasks
     SET state = 'in_progress', rework_count = rework_count + 1, completed_at = NULL, blocker_reason = '', updated_at = now()
   WHERE id = p_task_id;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'reworked', jsonb_build_object('reason', left(coalesce(p_reason, ''), 500)));
  RETURN QUERY SELECT 'reworked'::text, ''::text;
END
$$;

-- A board drag (and the PATCH route): the transition table, plus the tested-sha gate into done.
CREATE FUNCTION app.tasks_move(p_task_id uuid, p_to text)
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

-- The sweep: a claim past its expiry is released and the card goes back to open (the job `tasks.claim-timeout`).
CREATE FUNCTION app.tasks_expire_claims()
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_row record;
  v_n integer := 0;
BEGIN
  FOR v_row IN
    SELECT c.id, c.task_id, c.team_id, c.actor_id FROM app.task_claims c
     WHERE c.released_at IS NULL AND c.expires_at <= now()
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE app.task_claims SET released_at = now() WHERE id = v_row.id;
    UPDATE app.tasks SET owner_id = NULL, state = 'open', updated_at = now()
     WHERE id = v_row.task_id AND owner_id = v_row.actor_id AND state <> 'done';
    INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
    VALUES (v_row.task_id, v_row.team_id, NULL, 'released', jsonb_build_object('reason', 'claim expired'));
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$$;

-- Deploy checks, in one place: window, daily cap, then whether a person must approve it. Answers 'deployed' only when it may run.
CREATE FUNCTION app.tasks_deploy_check(p_environment_id uuid, p_task_id uuid)
  RETURNS TABLE (o_outcome text, o_reason text, o_requires_approval boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_env  record;
  v_now  timestamptz := now();
  v_dow  integer := extract(isodow FROM v_now)::int;
  v_time text := to_char(v_now AT TIME ZONE 'UTC', 'HH24:MI');
  v_win  boolean := false;
  v_n    integer;
BEGIN
  SELECT e.* INTO v_env FROM app.environments e
   WHERE e.id = p_environment_id AND e.team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, 'no such environment'::text, false;
    RETURN;
  END IF;
  IF p_task_id IS NOT NULL THEN
    PERFORM 1 FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = v_env.team_id;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'not_found'::text, 'no such card in this team'::text, false;
      RETURN;
    END IF;
  END IF;
  IF jsonb_array_length(v_env.windows) > 0 THEN
    SELECT EXISTS (
      SELECT 1
        FROM jsonb_to_recordset(v_env.windows) AS w(days text[], "from" text, "to" text)
       WHERE v_dow = ANY (ARRAY(SELECT CASE d
                                        WHEN 'mon' THEN 1 WHEN 'tue' THEN 2 WHEN 'wed' THEN 3 WHEN 'thu' THEN 4
                                        WHEN 'fri' THEN 5 WHEN 'sat' THEN 6 WHEN 'sun' THEN 7 END
                               FROM unnest(w.days) AS d))
         AND v_time >= w."from" AND v_time < w."to"
    ) INTO v_win;
    IF NOT v_win THEN
      RETURN QUERY SELECT 'outside_window'::text, 'this environment only deploys inside its windows'::text, false;
      RETURN;
    END IF;
  END IF;
  IF v_env.deploy_cap IS NOT NULL THEN
    SELECT count(*)::int INTO v_n FROM app.deploys d
     WHERE d.environment_id = v_env.id AND d.created_at >= date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    IF v_n >= v_env.deploy_cap THEN
      RETURN QUERY SELECT 'cap_reached'::text, format('this environment already deployed %s times today', v_n), false;
      RETURN;
    END IF;
  END IF;
  IF v_env.protected OR v_env.needs_approval THEN
    RETURN QUERY SELECT 'needs_approval'::text, 'this environment is protected: someone other than the requester must approve the deploy'::text, true;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'deployed'::text, ''::text, false;
END
$$;

-- Record one deploy (the ledger the cap counts) and its card history.
CREATE FUNCTION app.tasks_record_deploy(p_environment_id uuid, p_task_id uuid, p_actor uuid, p_note text)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_env record;
  v_id  bigint;
BEGIN
  SELECT e.* INTO v_env FROM app.environments e WHERE e.id = p_environment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such environment' USING ERRCODE = '23503';
  END IF;
  INSERT INTO app.deploys (workspace_id, team_id, environment_id, task_id, actor_id)
  VALUES (v_env.workspace_id, v_env.team_id, v_env.id, p_task_id, p_actor)
  RETURNING (extract(epoch FROM created_at) * 1000)::bigint INTO v_id;
  IF p_task_id IS NOT NULL THEN
    INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
    VALUES (p_task_id, v_env.team_id, p_actor, 'deployed',
            jsonb_build_object('environmentId', v_env.id, 'environment', v_env.name, 'note', left(coalesce(p_note, ''), 300)));
  END IF;
  RETURN v_id;
END
$$;

-- Create ------------------------------------------------------------------------------------------------------
-- One card and its `created` history in one transaction, as the system. The route validates the request; the door repeats the only checks
-- that must hold for every writer: the caller is a member of the team and the card is stamped with the caller as its creator.
CREATE FUNCTION app.tasks_create(
  p_workspace uuid, p_team uuid, p_goal uuid, p_title text, p_description text, p_kind text, p_priority text,
  p_branch text, p_environment uuid, p_created_by uuid
) RETURNS SETOF app.tasks
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_task app.tasks;
BEGIN
  IF p_created_by IS DISTINCT FROM app.actor() THEN
    RAISE EXCEPTION 'a card is created by its caller' USING ERRCODE = '42501';
  END IF;
  IF p_team IS NULL OR NOT (p_team = ANY ((SELECT app.readable_team_ids('post'))::uuid[])) THEN
    RAISE EXCEPTION 'not a member of this team' USING ERRCODE = '42501';
  END IF;
  IF p_goal IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.goals g WHERE g.id = p_goal AND g.team_id = p_team) THEN
    RAISE EXCEPTION 'no such goal in this team' USING ERRCODE = '23503';
  END IF;
  IF p_environment IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.environments e WHERE e.id = p_environment AND e.team_id = p_team) THEN
    RAISE EXCEPTION 'no such environment in this team' USING ERRCODE = '23503';
  END IF;
  INSERT INTO app.tasks (workspace_id, team_id, goal_id, title, description, kind, priority, branch, environment_id, created_by)
  VALUES (p_workspace, p_team, p_goal, p_title, p_description, p_kind, p_priority, p_branch, p_environment, p_created_by)
  RETURNING * INTO v_task;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (v_task.id, p_team, p_created_by, 'created', jsonb_build_object('kind', p_kind, 'priority', p_priority));
  RETURN NEXT v_task;
END
$$;

-- Resolve another actor of the caller's workspace: `app.actors` is own-row-only under RLS, and a handover has to name a real target.
CREATE FUNCTION app.tasks_actor_of(p_actor uuid) RETURNS TABLE (o_kind text, o_ref_id uuid, o_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT a.kind, a.ref_id, coalesce(p.display_name, b.name, 'someone')
    FROM app.actors a
    LEFT JOIN app.people p ON p.id = a.ref_id AND a.kind = 'person'
    LEFT JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot'
   WHERE a.id = p_actor AND a.workspace_id = app.workspace_id()
$$;

-- The active bot of a team by slug, with its actor: the same lookup a handover by `BOT.md` name needs.
CREATE FUNCTION app.tasks_bot_of(p_team uuid, p_slug text) RETURNS TABLE (o_actor_id uuid, o_bot_id uuid, o_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT a.id, b.id, b.name
    FROM app.bots b
    JOIN app.actors a ON a.ref_id = b.id AND a.kind = 'bot'
   WHERE b.team_id = p_team AND b.slug = p_slug AND b.status = 'active'
$$;

-- Ownership and privileges -------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_claim(uuid, integer) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_release(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_complete(uuid, text, text) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_handoff(uuid, uuid, text, text, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_apply_handoff(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_rework(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_move(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_expire_claims() OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_deploy_check(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_record_deploy(uuid, uuid, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_handoff_pending(uuid, uuid, text, text) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_attach_approval(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_deploy_request(uuid, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_apply_deploy(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_create(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_actor_of(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_bot_of(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

REVOKE ALL ON FUNCTION
  app.tasks_claim(uuid, integer), app.tasks_release(uuid), app.tasks_complete(uuid, text, text),
  app.tasks_handoff(uuid, uuid, text, text, uuid), app.tasks_apply_handoff(uuid), app.tasks_rework(uuid, text),
  app.tasks_move(uuid, text), app.tasks_expire_claims(), app.tasks_deploy_check(uuid, uuid), app.tasks_record_deploy(uuid, uuid, uuid, text),
  app.tasks_handoff_pending(uuid, uuid, text, text), app.tasks_attach_approval(uuid, uuid), app.tasks_deploy_request(uuid, uuid, text),
  app.tasks_apply_deploy(uuid), app.tasks_create(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid),
  app.tasks_actor_of(uuid), app.tasks_bot_of(uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.tasks_claim(uuid, integer), app.tasks_release(uuid), app.tasks_complete(uuid, text, text),
  app.tasks_handoff(uuid, uuid, text, text, uuid), app.tasks_apply_handoff(uuid), app.tasks_rework(uuid, text),
  app.tasks_move(uuid, text), app.tasks_expire_claims(), app.tasks_deploy_check(uuid, uuid), app.tasks_record_deploy(uuid, uuid, uuid, text),
  app.tasks_handoff_pending(uuid, uuid, text, text), app.tasks_attach_approval(uuid, uuid), app.tasks_deploy_request(uuid, uuid, text),
  app.tasks_apply_deploy(uuid), app.tasks_create(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid),
  app.tasks_actor_of(uuid), app.tasks_bot_of(uuid, text)
  TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.tasks_claim(uuid, integer) IS
  'Claim a card: one live claim per card (`task_claims_live`); answers claimed | already_owned | not_claimable | not_found.';
COMMENT ON FUNCTION app.tasks_complete(uuid, text, text) IS
  'Mark a card done as its owner: a code card needs tested_sha, and a base_sha that differs from the branch head is refused with the reason.';
COMMENT ON FUNCTION app.tasks_handoff(uuid, uuid, text, text, uuid) IS
  'Move a card to another owner in one transaction: releases the old claim, counts the handoff, records it; bounded at five.';
COMMENT ON FUNCTION app.tasks_deploy_check(uuid, uuid) IS
  'Deploy rules in one place: window, daily cap, and whether the environment makes a person approve it (protected / needs_approval).';
