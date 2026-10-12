-- approvals plugin 0001: the Approvals inbox (PLAN.md A.5, P5-20; SPEC §7.3). Forward-only: never edit once applied.
--
--  * approvals: one call waiting for a person. One mechanism, four sources (`environment`, `dispatch`, `dlp`, `grant`): the source only
--    says why it waits. `args_preview` is what an approver is shown (clipped, secrets hidden by the writer; `args_truncated` says it was
--    clipped); `resume` is what approving does and may carry the call's real arguments, so it is the one column manythreads_app is not
--    granted. `approver_scope` is the resolved list of who may decide (role tags, people, or the team's leads when none is named).
--    A pending approval lapses at `expires_at` (`expired`); an approved one is claimed (`queued` → `running`) before its call is made.
--  * approval_decisions: the one decision that settles an approval (UNIQUE per approval), with the decider and a note.
--
-- Who reads: the people of the team who can also read the channel the run answered in. An approval raised in a private channel, a DM or a
-- bot conversation (its summary, preview and the redacted excerpt of a DLP hold are made of that conversation) is visible to the people
-- who can read *that channel* and to no one else on the team; an approver who cannot read it cannot decide it.
--
-- Who writes: only through the definer doors below. `app.approvals_request` takes a *run* and reads the bot, team, asker and thread from
-- it, so a caller cannot file an approval for another bot's run; `app.approvals_decide` is the only way a status changes from `pending`, and
-- it refuses the requester and anyone outside the approver scope. The request role has no INSERT/UPDATE/DELETE on either table.
--
-- Ordering: the manifest's `dependsOn: ['bots', 'channels']` puts this after app.bots, app.bot_runs and app.channels.

CREATE TABLE app.approvals (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('environment', 'dispatch', 'dlp', 'grant')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  outcome        text NOT NULL DEFAULT 'none' CHECK (outcome IN ('none', 'queued', 'running', 'ran', 'failed')),
  outcome_detail text NOT NULL DEFAULT '' CHECK (char_length(outcome_detail) <= 500),
  tool           text NOT NULL CHECK (char_length(tool) BETWEEN 1 AND 200),
  summary        text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 300),
  args_preview   jsonb NOT NULL DEFAULT '{}'::jsonb,
  args_truncated boolean NOT NULL DEFAULT false,
  resume         jsonb NOT NULL,
  -- what kind of resume the row holds, readable without the arguments: `tool` (the approvals plugin re-runs it) or `handoff` (the asker takes it back)
  resume_kind    text GENERATED ALWAYS AS (resume ->> 'kind') STORED CHECK (resume_kind IN ('tool', 'handoff')),
  approver_scope jsonb NOT NULL,
  requester_id   uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  -- the name as it was when the request was filed: actors are readable only by themselves, so a list cannot join them
  requester_name text NOT NULL DEFAULT '' CHECK (char_length(requester_name) <= 200),
  bot_id         uuid REFERENCES app.bots (id) ON DELETE CASCADE,
  run_id         uuid REFERENCES app.bot_runs (id) ON DELETE SET NULL,
  channel_id     uuid REFERENCES app.channels (id) ON DELETE SET NULL,
  thread_root_id uuid,
  dedupe_key     text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) <= 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '7 days',
  decided_at     timestamptz,
  started_at     timestamptz,
  CONSTRAINT approvals_decided_at CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT approvals_outcome_after_approval CHECK (status = 'approved' OR outcome = 'none'),
  -- the tool the inbox shows is the call that will be made: a row cannot say one thing and run another
  CONSTRAINT approvals_tool_is_capability CHECK (resume_kind <> 'tool' OR resume ->> 'capability' = tool)
);
CREATE INDEX approvals_team ON app.approvals (team_id);
CREATE INDEX approvals_team_pending ON app.approvals (team_id, id DESC) WHERE status = 'pending';
CREATE INDEX approvals_team_decided ON app.approvals (team_id, decided_at DESC) WHERE status <> 'pending';
CREATE INDEX approvals_workspace ON app.approvals (workspace_id);
CREATE INDEX approvals_requester ON app.approvals (requester_id);
CREATE INDEX approvals_bot ON app.approvals (bot_id) WHERE bot_id IS NOT NULL;
CREATE INDEX approvals_run ON app.approvals (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX approvals_channel ON app.approvals (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX approvals_thread ON app.approvals (thread_root_id, id) WHERE thread_root_id IS NOT NULL;
-- the sweep: pending ones that lapsed, approved ones that never finished
CREATE INDEX approvals_pending_expiry ON app.approvals (expires_at) WHERE status = 'pending';
CREATE INDEX approvals_unfinished ON app.approvals (decided_at) WHERE status = 'approved' AND outcome IN ('queued', 'running');
-- asking twice for the same pending thing is one approval *per asker*: a second person asking for the identical call gets a request of their
-- own, which the first cannot be approved through (the requester of an approval is who it can never be approved by)
CREATE UNIQUE INDEX approvals_dedupe ON app.approvals (bot_id, requester_id, dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL;
COMMENT ON TABLE app.approvals IS 'rls: team — T: approvals of the teams the caller can read (app.readable_team_ids) and of channels the caller can read (app.visible_channel_ids); written only through app.approvals_request / app.approvals_decide and by the system role; the `resume` column (the call''s real arguments) and `dedupe_key` are not granted to manythreads_app.';

CREATE TABLE app.approval_decisions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  approval_id  uuid NOT NULL REFERENCES app.approvals (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  decider_id   uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  decider_name text NOT NULL DEFAULT '' CHECK (char_length(decider_name) <= 200),
  decision     text NOT NULL CHECK (decision IN ('approved', 'denied')),
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  decided_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approval_decisions_approval ON app.approval_decisions (approval_id);
CREATE INDEX approval_decisions_workspace ON app.approval_decisions (workspace_id);
CREATE INDEX approval_decisions_team ON app.approval_decisions (team_id);
CREATE INDEX approval_decisions_decider ON app.approval_decisions (decider_id);
COMMENT ON TABLE app.approval_decisions IS 'rls: team — T: the decision that settled an approval, readable with its approval (same team and channel visibility); written only by app.approvals_decide.';

-- Row level security ----------------------------------------------------------------------------------------------------
-- Both sets are hoisted: one evaluation per statement, never one per row.
ALTER TABLE app.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_select ON app.approvals FOR SELECT USING (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
      AND (channel_id IS NULL OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]))));
CREATE POLICY approvals_system ON app.approvals FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

ALTER TABLE app.approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.approval_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_decisions_select ON app.approval_decisions FOR SELECT USING (
  (SELECT app.is_system())
  OR approval_id IN (SELECT a.id FROM app.approvals a));
CREATE POLICY approval_decisions_system ON app.approval_decisions FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- Everything but `resume` and `dedupe_key`: a request reads what an approver is shown, never the real arguments.
GRANT SELECT (id, workspace_id, team_id, source, status, outcome, outcome_detail, tool, summary, args_preview, args_truncated, resume_kind,
              approver_scope, requester_id, requester_name, bot_id, run_id, channel_id, thread_root_id, created_at, expires_at, decided_at, started_at)
  ON app.approvals TO manythreads_app;
GRANT SELECT ON app.approval_decisions TO manythreads_app;

-- The door that files an approval ---------------------------------------------------------------------------------------
-- A run is what an approval hangs from: the bot, the team, the workspace, the person who asked and the thread the run answers in are read
-- from it. The caller is either the system role (a job, an event consumer: `session_user` is the login, not a setting) or the run's own bot in
-- the run's own transaction (`app.actor()` is the bot and `app.run_id()` is this run). Anyone else is refused (42501).
-- `p_approvers` is the list the caller wants (role:/person: principals) or NULL for the bot's own `approvers`; none named means the leads.
-- Asking twice for the same pending thing (same bot, same asker, same key) is one approval; a different asker gets an approval of their own.
CREATE FUNCTION app.approvals_request(
  p_run_id uuid, p_source text, p_tool text, p_summary text, p_args_preview jsonb, p_args_truncated boolean, p_resume jsonb,
  p_approvers text[], p_dedupe_key text
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
  v_requester_name text;
  v_try     integer := 0;
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
  SELECT coalesce(p.display_name, b.name, 'someone') INTO v_requester_name
    FROM app.actors k
    LEFT JOIN app.people p ON p.id = k.ref_id AND k.kind = 'person'
    LEFT JOIN app.bots b ON b.id = k.ref_id AND k.kind = 'bot'
   WHERE k.id = v_requester;
  v_list := coalesce(p_approvers, (SELECT b.approvers FROM app.bots b WHERE b.id = v_run.bot_id), '{}');
  v_scope := jsonb_build_object(
    'roles', coalesce((SELECT jsonb_agg(DISTINCT p) FROM unnest(v_list) AS p WHERE p ~ '^role:[a-z][a-z0-9-]*$'), '[]'::jsonb),
    'people', coalesce((SELECT jsonb_agg(DISTINCT substr(p, 8)) FROM unnest(v_list) AS p
                         WHERE p ~ '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '[]'::jsonb),
    'leads', NOT EXISTS (SELECT 1 FROM unnest(v_list) AS p WHERE p ~ '^role:[a-z][a-z0-9-]*$'
                    OR p ~ '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );

  -- insert; on a duplicate pending key of the same asker take the existing one; if that one was decided in the meantime (so the conflict is
  -- gone and the lookup finds nothing), go round again — the insert then succeeds. Bounded, and never answers a NULL id.
  LOOP
    v_try := v_try + 1;
    INSERT INTO app.approvals AS a (workspace_id, team_id, source, tool, summary, args_preview, args_truncated, resume, approver_scope, requester_id,
                                    bot_id, run_id, channel_id, thread_root_id, dedupe_key, requester_name)
    VALUES (v_run.workspace_id, v_run.team_id, p_source, p_tool, p_summary, coalesce(p_args_preview, '{}'::jsonb), coalesce(p_args_truncated, false),
            p_resume, v_scope, v_requester, v_run.bot_id, v_run.id, v_run.channel_id, v_run.reply_root_id, p_dedupe_key,
            coalesce(v_requester_name, 'someone'))
    ON CONFLICT (bot_id, requester_id, dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL DO NOTHING
    RETURNING a.id INTO v_id;
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, true, v_run.workspace_id, v_run.team_id, v_run.bot_id, v_run.id, v_requester;
      RETURN;
    END IF;
    SELECT a.id INTO v_id FROM app.approvals a
     WHERE a.bot_id = v_run.bot_id AND a.requester_id = v_requester AND a.dedupe_key = p_dedupe_key AND a.status = 'pending';
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, false, v_run.workspace_id, v_run.team_id, v_run.bot_id, v_run.id, v_requester;
      RETURN;
    END IF;
    IF v_try >= 5 THEN
      RAISE EXCEPTION 'could not file the approval (concurrent changes)' USING ERRCODE = '40001';
    END IF;
  END LOOP;
END
$$;

-- Who may decide, for a set of approvals, as reason codes: NULL means the caller may. `requester` (the person who asked can never decide
-- their own request, whatever else they are), `not_approver`, `not_pending` (settled, expired, or past its time), `not_found` (no such
-- approval *that the caller can see*: another team's, or one in a channel the caller cannot read, answers the same as a missing id).
-- The caller's facts (who they are, the teams and channels they read, the tags they hold, the teams they lead) are computed once, not once
-- per approval. Inside a definer function owned by manythreads_system app.is_system() is always true, so the caller is judged only through the
-- lookup functions (kernel 0006) and the visibility sets, never through the is_* helpers.
CREATE FUNCTION app.approvals_block_reasons(p_ids uuid[]) RETURNS TABLE (o_id uuid, o_reason text)
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
  SELECT a.id,
         CASE
           WHEN v_ws IS NULL OR a.workspace_id <> v_ws THEN 'not_found'
           WHEN NOT (a.team_id = ANY (v_teams) AND (a.channel_id IS NULL OR a.channel_id = ANY (v_chans))) THEN 'not_found'
           WHEN a.status <> 'pending' OR a.expires_at <= now() THEN 'not_pending'
           WHEN v_kind IS DISTINCT FROM 'person' THEN 'not_approver'
           WHEN a.requester_id = v_actor THEN 'requester'
           WHEN v_role IS NULL OR v_role = 'guest' THEN 'not_approver'
           WHEN v_person::text IN (SELECT jsonb_array_elements_text(a.approver_scope -> 'people')) THEN NULL
           WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.approver_scope -> 'roles') AS t(name) WHERE t.name = ANY (v_held)) THEN NULL
           WHEN coalesce((a.approver_scope ->> 'leads')::boolean, false) AND (a.team_id = ANY (v_leads) OR v_role IN ('owner', 'admin')) THEN NULL
           ELSE 'not_approver'
         END
    FROM app.approvals a
   WHERE a.id = ANY (p_ids);
END
$$;

-- The same answer for one approval ('not_found' when the caller cannot see it).
CREATE FUNCTION app.approvals_block_reason(p_approval_id uuid) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_found boolean := false;
  v_reason text;
BEGIN
  SELECT true, r.o_reason INTO v_found, v_reason FROM app.approvals_block_reasons(ARRAY[p_approval_id]) AS r;
  IF NOT coalesce(v_found, false) THEN RETURN 'not_found'; END IF;
  RETURN v_reason;
END
$$;

-- The door that settles one: checks, flips `pending` once (a second decider gets 55000) and writes the decision. Approving queues the
-- stopped action (`outcome = 'queued'`); denying leaves nothing to do.
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
  IF v_reason IN ('requester', 'not_approver', 'not_found') THEN
    RAISE EXCEPTION 'you may not decide this approval (%)', v_reason USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'this approval is already settled' USING ERRCODE = '55000';
  END IF;
  UPDATE app.approvals a
     SET status = p_decision, decided_at = now(), outcome = CASE WHEN p_decision = 'approved' THEN 'queued' ELSE 'none' END
   WHERE a.id = p_approval_id AND a.status = 'pending' AND a.expires_at > now()
   RETURNING a.workspace_id, a.team_id INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this approval is already settled' USING ERRCODE = '55000';
  END IF;
  INSERT INTO app.approval_decisions (approval_id, workspace_id, team_id, decider_id, decider_name, decision, note)
  VALUES (p_approval_id, v_row.workspace_id, v_row.team_id, app.actor(),
          coalesce((SELECT p.display_name FROM app.actors k JOIN app.people p ON p.id = k.ref_id WHERE k.id = app.actor() AND k.kind = 'person'), 'someone'),
          p_decision, left(coalesce(p_note, ''), 500))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- The full arguments of a stored tool call, for the people who may decide it and nobody else (the preview is clipped; an approver who
-- cannot read what they are approving should not be asked to). NULL for a hand-back, which stores no arguments. 42501 for anyone else.
CREATE FUNCTION app.approvals_full_args(p_approval_id uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF app.approvals_block_reason(p_approval_id) IS NOT NULL THEN
    RAISE EXCEPTION 'only the people who may decide this approval can read the full call' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT a.resume -> 'args' FROM app.approvals a WHERE a.id = p_approval_id);
END
$$;

ALTER FUNCTION app.approvals_request(uuid, text, text, text, jsonb, boolean, jsonb, text[], text) OWNER TO manythreads_system;
ALTER FUNCTION app.approvals_block_reasons(uuid[]) OWNER TO manythreads_system;
ALTER FUNCTION app.approvals_block_reason(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.approvals_decide(uuid, text, text) OWNER TO manythreads_system;
ALTER FUNCTION app.approvals_full_args(uuid) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.approvals_request(uuid, text, text, text, jsonb, boolean, jsonb, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.approvals_block_reasons(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.approvals_block_reason(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.approvals_decide(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.approvals_full_args(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approvals_request(uuid, text, text, text, jsonb, boolean, jsonb, text[], text) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.approvals_block_reasons(uuid[]) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.approvals_block_reason(uuid) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.approvals_decide(uuid, text, text) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.approvals_full_args(uuid) TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.approvals_request(uuid, text, text, text, jsonb, boolean, jsonb, text[], text) IS
  'File a pending approval for a run (bot, team, asker and thread are read from the run); callable by the run''s own bot in its own transaction or by the system. Answers (approval id, created); a pending approval with the same dedupe key of the same bot and the same asker is returned instead.';
COMMENT ON FUNCTION app.approvals_block_reasons(uuid[]) IS
  'For each approval the caller can see: NULL when the caller may decide it now, otherwise requester | not_approver | not_pending | not_found. Computed set-wise.';
COMMENT ON FUNCTION app.approvals_block_reason(uuid) IS
  'The same answer for one approval; not_found when the caller cannot see it.';
COMMENT ON FUNCTION app.approvals_decide(uuid, text, text) IS
  'Approve or deny a pending approval as the caller: refuses the requester and anyone outside the approver scope (42501), and a second decision or a lapsed one (55000). Answers the decision id.';
COMMENT ON FUNCTION app.approvals_full_args(uuid) IS
  'The stored arguments of a tool call, for the people who may decide the approval (42501 for anyone else).';

GRANT CREATE ON SCHEMA app TO manythreads_system;
