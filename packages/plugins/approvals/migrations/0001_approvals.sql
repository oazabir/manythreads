-- approvals plugin 0001: the Approvals inbox (PLAN.md A.5, P5-20; SPEC §7.3). Forward-only: never edit once applied.
--
--  * approvals: one call waiting for a person. One mechanism, four sources (`environment`, `dispatch`, `dlp`, `grant`): the source only
--    says why it waits. `args_preview` is what an approver is shown (clipped, secrets hidden by the writer); `resume` is what approving
--    does and may carry the call's real arguments, so it is the one column manythreads_app is not granted. `approver_scope` is the
--    resolved list of who may decide (role tags, people, or the team's leads when none is named).
--  * approval_decisions: the one decision that settles an approval (UNIQUE per approval), with the decider and a note.
--
-- Who writes: only through the two definer doors below. `app.approvals_request` takes a *run* and reads the bot, team, asker and thread from
-- it, so a caller cannot file an approval for another bot's run; `app.approvals_decide` is the only way a status changes from `pending`, and
-- it refuses the requester and anyone outside the approver scope. The request role has no INSERT/UPDATE/DELETE on either table.
--
-- Ordering: the manifest's `dependsOn: ['bots', 'channels']` puts this after app.bots, app.bot_runs and app.channels.

CREATE TABLE app.approvals (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('environment', 'dispatch', 'dlp', 'grant')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  outcome        text NOT NULL DEFAULT 'none' CHECK (outcome IN ('none', 'queued', 'ran', 'failed')),
  outcome_detail text NOT NULL DEFAULT '' CHECK (char_length(outcome_detail) <= 500),
  tool           text NOT NULL CHECK (char_length(tool) BETWEEN 1 AND 200),
  summary        text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 300),
  args_preview   jsonb NOT NULL DEFAULT '{}'::jsonb,
  resume         jsonb NOT NULL,
  -- what kind of resume the row holds, readable without the arguments: `tool` (the approvals plugin re-runs it) or `handoff` (the asker takes it back)
  resume_kind    text GENERATED ALWAYS AS (resume ->> 'kind') STORED CHECK (resume_kind IN ('tool', 'handoff')),
  approver_scope jsonb NOT NULL,
  requester_id   uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  bot_id         uuid REFERENCES app.bots (id) ON DELETE CASCADE,
  run_id         uuid REFERENCES app.bot_runs (id) ON DELETE SET NULL,
  channel_id     uuid REFERENCES app.channels (id) ON DELETE SET NULL,
  thread_root_id uuid,
  dedupe_key     text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) <= 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  CONSTRAINT approvals_decided_at CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT approvals_outcome_after_approval CHECK (status = 'approved' OR outcome = 'none')
);
CREATE INDEX approvals_team_pending ON app.approvals (team_id, id DESC) WHERE status = 'pending';
CREATE INDEX approvals_team_decided ON app.approvals (team_id, decided_at DESC) WHERE status <> 'pending';
CREATE INDEX approvals_workspace ON app.approvals (workspace_id);
CREATE INDEX approvals_requester ON app.approvals (requester_id);
CREATE INDEX approvals_bot ON app.approvals (bot_id) WHERE bot_id IS NOT NULL;
CREATE INDEX approvals_run ON app.approvals (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX approvals_channel ON app.approvals (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX approvals_thread ON app.approvals (thread_root_id, id) WHERE thread_root_id IS NOT NULL;
CREATE UNIQUE INDEX approvals_dedupe ON app.approvals (bot_id, dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL;
COMMENT ON TABLE app.approvals IS 'rls: team — T: approvals of the teams the caller can read (app.readable_team_ids); written only through app.approvals_request / app.approvals_decide and by the system role; the `resume` column (the call''s real arguments) is not granted to manythreads_app.';

CREATE TABLE app.approval_decisions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  approval_id  uuid NOT NULL REFERENCES app.approvals (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  decider_id   uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  decision     text NOT NULL CHECK (decision IN ('approved', 'denied')),
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  decided_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approval_decisions_approval ON app.approval_decisions (approval_id);
CREATE INDEX approval_decisions_workspace ON app.approval_decisions (workspace_id);
CREATE INDEX approval_decisions_team ON app.approval_decisions (team_id);
CREATE INDEX approval_decisions_decider ON app.approval_decisions (decider_id);
COMMENT ON TABLE app.approval_decisions IS 'rls: team — T: the decision that settled an approval, readable with its team; written only by app.approvals_decide.';

-- Row level security ----------------------------------------------------------------------------------------------------
ALTER TABLE app.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_select ON app.approvals FOR SELECT USING (
  (SELECT app.is_system())
  OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY approvals_system ON app.approvals FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

ALTER TABLE app.approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.approval_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_decisions_select ON app.approval_decisions FOR SELECT USING (
  (SELECT app.is_system())
  OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY approval_decisions_system ON app.approval_decisions FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- Everything but `resume`: a request reads what an approver is shown, never the real arguments.
GRANT SELECT (id, workspace_id, team_id, source, status, outcome, outcome_detail, tool, summary, args_preview, resume_kind, approver_scope,
              requester_id, bot_id, run_id, channel_id, thread_root_id, dedupe_key, created_at, decided_at)
  ON app.approvals TO manythreads_app;
GRANT SELECT ON app.approval_decisions TO manythreads_app;

-- The door that files an approval ---------------------------------------------------------------------------------------
-- A run is what an approval hangs from: the bot, the team, the workspace, the person who asked and the thread the run answers in are read
-- from it. The caller is either the system role (a job, an event consumer: `session_user` is the login, not a setting) or the run's own bot in
-- the run's own transaction (`app.actor()` is the bot's actor and `app.run_id()` is this run). Anyone else is refused (42501).
-- `p_approvers` is the list the caller wants (role:/person: principals) or NULL for the bot's own `approvers`; none named means the leads.
CREATE FUNCTION app.approvals_request(
  p_run_id uuid, p_source text, p_tool text, p_summary text, p_args_preview jsonb, p_resume jsonb, p_approvers text[], p_dedupe_key text
) RETURNS TABLE (o_id uuid, o_created boolean, o_workspace_id uuid, o_team_id uuid, o_bot_id uuid, o_run_id uuid, o_requester_id uuid)
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
  v_list := coalesce(p_approvers, (SELECT b.approvers FROM app.bots b WHERE b.id = v_run.bot_id), '{}');
  v_scope := jsonb_build_object(
    'roles', coalesce((SELECT jsonb_agg(DISTINCT p) FROM unnest(v_list) AS p WHERE p ~ '^role:[a-z][a-z0-9-]*$'), '[]'::jsonb),
    'people', coalesce((SELECT jsonb_agg(DISTINCT substr(p, 8)) FROM unnest(v_list) AS p
                         WHERE p ~ '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '[]'::jsonb),
    'leads', NOT EXISTS (SELECT 1 FROM unnest(v_list) AS p WHERE p ~ '^role:[a-z][a-z0-9-]*$'
                    OR p ~ '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );

  INSERT INTO app.approvals AS a (workspace_id, team_id, source, tool, summary, args_preview, resume, approver_scope, requester_id, bot_id,
                                  run_id, channel_id, thread_root_id, dedupe_key)
  VALUES (v_run.workspace_id, v_run.team_id, p_source, p_tool, p_summary, coalesce(p_args_preview, '{}'::jsonb), p_resume, v_scope,
          v_requester, v_run.bot_id, v_run.id, v_run.channel_id, v_run.reply_root_id, p_dedupe_key)
  ON CONFLICT (bot_id, dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL DO NOTHING
  RETURNING a.id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true, v_run.workspace_id, v_run.team_id, v_run.bot_id, v_run.id, v_requester;
    RETURN;
  END IF;
  SELECT a.id INTO v_id FROM app.approvals a WHERE a.bot_id = v_run.bot_id AND a.dedupe_key = p_dedupe_key AND a.status = 'pending';
  RETURN QUERY SELECT v_id, false, v_run.workspace_id, v_run.team_id, v_run.bot_id, v_run.id, v_requester;
END
$$;

-- Who may decide, as a reason code the caller can show: NULL means they may. `requester` (the person who asked can never decide their own
-- request, whatever else they are), `not_approver`, `not_pending`, `not_found`. The caller is app.actor(); inside this definer function
-- app.is_system() is always true, so the caller is judged only through the lookup functions (kernel 0006), never through the is_* helpers.
CREATE FUNCTION app.approvals_block_reason(p_approval_id uuid) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v        record;
  v_actor  uuid := app.actor();
  v_ws     uuid := app.workspace_id();
  v_kind   text;
  v_person uuid;
  v_role   text;
  v_roles  text[];
  v_people text[];
BEGIN
  SELECT a.status, a.team_id, a.requester_id, a.approver_scope INTO v FROM app.approvals a WHERE a.id = p_approval_id AND a.workspace_id = v_ws;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v.status <> 'pending' THEN RETURN 'not_pending'; END IF;
  IF v_actor IS NULL OR v_ws IS NULL THEN RETURN 'not_approver'; END IF;
  SELECT k.kind, k.ref_id INTO v_kind, v_person FROM app.actors k WHERE k.id = v_actor AND k.workspace_id = v_ws;
  IF v_kind IS DISTINCT FROM 'person' THEN RETURN 'not_approver'; END IF;
  IF v.requester_id = v_actor THEN RETURN 'requester'; END IF;
  v_role := app.lookup_workspace_role();
  IF v_role IS NULL OR v_role = 'guest' THEN RETURN 'not_approver'; END IF;
  IF NOT (v.team_id = ANY (app.readable_team_ids('read'))) THEN RETURN 'not_approver'; END IF;

  v_roles := ARRAY(SELECT jsonb_array_elements_text(v.approver_scope -> 'roles'));
  v_people := ARRAY(SELECT jsonb_array_elements_text(v.approver_scope -> 'people'));
  IF v_person::text = ANY (v_people) THEN RETURN NULL; END IF;
  IF cardinality(v_roles) > 0 AND EXISTS (
       SELECT 1 FROM app.role_members rm JOIN app.roles r ON r.id = rm.role_id
        WHERE rm.person_id = v_person AND rm.workspace_id = v_ws AND r.workspace_id = v_ws AND r.name = ANY (v_roles)) THEN
    RETURN NULL;
  END IF;
  IF coalesce((v.approver_scope ->> 'leads')::boolean, false)
     AND (app.lookup_team_role(v.team_id) = 'lead' OR v_role IN ('owner', 'admin')) THEN
    RETURN NULL;
  END IF;
  RETURN 'not_approver';
END
$$;

-- The door that settles one: checks, flips `pending` once (a second decider finds it settled, 55000) and writes the decision. Approving
-- queues the stopped action (`outcome = 'queued'`); denying leaves nothing to do.
CREATE FUNCTION app.approvals_decide(p_approval_id uuid, p_decision text, p_note text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_reason text := app.approvals_block_reason(p_approval_id);
  v_row    record;
  v_id     uuid;
BEGIN
  IF p_decision NOT IN ('approved', 'denied') THEN
    RAISE EXCEPTION 'a decision is approved or denied' USING ERRCODE = '22023';
  END IF;
  IF v_reason IN ('requester', 'not_approver') THEN
    RAISE EXCEPTION 'you may not decide this approval (%)', v_reason USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'this approval is already settled' USING ERRCODE = '55000';
  END IF;
  UPDATE app.approvals a
     SET status = p_decision, decided_at = now(), outcome = CASE WHEN p_decision = 'approved' THEN 'queued' ELSE 'none' END
   WHERE a.id = p_approval_id AND a.status = 'pending'
   RETURNING a.workspace_id, a.team_id INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this approval is already settled' USING ERRCODE = '55000';
  END IF;
  INSERT INTO app.approval_decisions (approval_id, workspace_id, team_id, decider_id, decision, note)
  VALUES (p_approval_id, v_row.workspace_id, v_row.team_id, app.actor(), p_decision, left(coalesce(p_note, ''), 500))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

ALTER FUNCTION app.approvals_request(uuid, text, text, text, jsonb, jsonb, text[], text) OWNER TO manythreads_system;
ALTER FUNCTION app.approvals_block_reason(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.approvals_decide(uuid, text, text) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.approvals_request(uuid, text, text, text, jsonb, jsonb, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.approvals_block_reason(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.approvals_decide(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approvals_request(uuid, text, text, text, jsonb, jsonb, text[], text) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.approvals_block_reason(uuid) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.approvals_decide(uuid, text, text) TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.approvals_request(uuid, text, text, text, jsonb, jsonb, text[], text) IS
  'File a pending approval for a run (bot, team, asker and thread are read from the run); callable by the run''s own bot in its own transaction or by the system. Answers (approval id, created); a pending approval with the same dedupe key of the same bot is returned instead.';
COMMENT ON FUNCTION app.approvals_block_reason(uuid) IS
  'NULL when the caller may decide the approval now; otherwise requester | not_approver | not_pending | not_found.';
COMMENT ON FUNCTION app.approvals_decide(uuid, text, text) IS
  'Approve or deny a pending approval as the caller: refuses the requester and anyone outside the approver scope (42501), and a second decision (55000). Answers the decision id.';

GRANT CREATE ON SCHEMA app TO manythreads_system;
