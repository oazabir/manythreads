-- proposals 0001: proposals for changes to bots/, TEAM.md, skills/ and routines/ (PLAN P7-01, SPEC 7.2 and principle 5). Forward-only: never edit once applied.
--
-- A proposal is one file's new text (or its removal) waiting for a team lead or a workspace admin to apply it. Rows are read by everyone who can read the
-- team (the files are readable by the team anyway) and written only through the definer functions below, which are the one place the rules live:
--
--   proposals_create          a person who may post in the team, or a bot of the team, makes a proposal (at most 50 open per author and team)
--   proposals_why_not         the reason the caller may NOT apply an open proposal, or NULL when they may (one rule, used by the view and by the decision)
--   proposals_decide          apply, reject or withdraw: the status changes only from 'open', by the person the rules name
--   proposals_other_approvers how many people other than one actor could apply a proposal in a team (decides the "only eligible approver" exception)
--
-- Inside a definer owned by the system role the is_* helpers are always true, so the caller is checked with the lookup_* functions (kernel 0006), which read
-- app.actor(). The system role itself is recognised through session_user (idiom of webhooks 0001).

CREATE TABLE app.proposals (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id          uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  author_id        uuid NOT NULL REFERENCES app.actors (id),
  author_kind      text NOT NULL CHECK (author_kind IN ('person', 'bot')),
  -- the author's name when the proposal was made (people cannot read each other's directory rows; the list shows this)
  author_name      text NOT NULL CHECK (char_length(author_name) BETWEEN 1 AND 200),
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 4000),
  path             text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 1024),
  op               text NOT NULL CHECK (op IN ('put', 'delete')),
  -- the proposed text; NULL for a removal. Never returned by the API (the diff is).
  content          text CHECK (content IS NULL OR char_length(content) <= 262144),
  -- the blob the proposal was made against (NULL: the file did not exist) and the repo head at that moment
  base_blob_sha    text CHECK (base_blob_sha IS NULL OR base_blob_sha ~ '^[0-9a-f]{40,64}$'),
  base_commit_sha  text NOT NULL CHECK (base_commit_sha ~ '^[0-9a-f]{40,64}$'),
  -- adding or removing a bot (a bots/ path that is new or deleted) is a workspace admin's alone
  needs_admin      boolean NOT NULL DEFAULT false,
  diff             text NOT NULL,
  added            integer NOT NULL DEFAULT 0 CHECK (added >= 0),
  removed          integer NOT NULL DEFAULT 0 CHECK (removed >= 0),
  checks           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checks) = 'array'),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'rejected', 'withdrawn')),
  self_applied     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  decided_by       uuid REFERENCES app.actors (id),
  decided_by_name  text CHECK (decided_by_name IS NULL OR char_length(decided_by_name) <= 200),
  decision_note    text CHECK (decision_note IS NULL OR char_length(decision_note) <= 4000),
  applied_commit_sha text CHECK (applied_commit_sha IS NULL OR applied_commit_sha ~ '^[0-9a-f]{40,64}$'),
  CONSTRAINT proposals_put_has_content CHECK ((op = 'put') = (content IS NOT NULL)),
  CONSTRAINT proposals_decided_together CHECK ((status = 'open') = (decided_at IS NULL))
);
CREATE INDEX proposals_workspace ON app.proposals (workspace_id);
CREATE INDEX proposals_team_status ON app.proposals (team_id, status, created_at DESC);
CREATE INDEX proposals_author ON app.proposals (author_id);
CREATE INDEX proposals_decided_by ON app.proposals (decided_by) WHERE decided_by IS NOT NULL;
COMMENT ON TABLE app.proposals IS 'rls: team — T: a proposed change to one file of bots/, TEAM.md, skills/ or routines/; everyone who can read the team reads it, every write is a definer function (proposals_create, proposals_decide) or the system role.';

ALTER TABLE app.proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY proposals_select ON app.proposals FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))
);
CREATE POLICY proposals_insert ON app.proposals FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY proposals_update ON app.proposals FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY proposals_delete ON app.proposals FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.proposals TO manythreads_app;

-- Other approvers -------------------------------------------------------------------------------------------------------------
-- How many people other than `p_exclude` (an actor) could apply a proposal of the team: its leads and the workspace's owners and admins, or only the
-- owners and admins when the proposal adds or removes a bot. Active people only; a guest never counts. A bare count, so it names nobody.
CREATE FUNCTION app.proposals_other_approvers(p_team_id uuid, p_admin_only boolean, p_exclude uuid) RETURNS integer
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws uuid;
  v_n  integer;
BEGIN
  SELECT t.workspace_id INTO v_ws FROM app.teams t WHERE t.id = p_team_id;
  IF v_ws IS NULL OR v_ws IS DISTINCT FROM app.workspace_id() THEN
    RETURN 0;
  END IF;
  SELECT count(DISTINCT a.id) INTO v_n
    FROM app.actors a
    JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id AND p.status = 'active'
    JOIN app.workspace_members wm ON wm.workspace_id = a.workspace_id AND wm.person_id = p.id
   WHERE a.kind = 'person' AND a.workspace_id = v_ws AND a.id <> p_exclude
     AND (
       wm.role IN ('owner', 'admin')
       OR (NOT p_admin_only AND wm.role <> 'guest'
           AND EXISTS (SELECT 1 FROM app.team_members tm WHERE tm.team_id = p_team_id AND tm.actor_id = a.id AND tm.role = 'lead'))
     );
  RETURN v_n;
END
$$;

-- Why the caller may not apply ------------------------------------------------------------------------------------------------
-- NULL: the caller may apply this proposal now. Otherwise the reason, in the words the screen shows. `p_self` is "propose and apply": the author applies
-- their own proposal at once, which a lead or admin has always been able to do to a file directly, and it is recorded as such.
-- The rule for a proposal the author saved for review: the author cannot apply it unless nobody else could (no other lead or admin who is eligible).
CREATE FUNCTION app.proposals_why_not(p_id uuid, p_self boolean DEFAULT false) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_row     app.proposals;
  v_caller  uuid := app.actor();
  v_kind    text;
BEGIN
  SELECT * INTO v_row FROM app.proposals WHERE id = p_id AND workspace_id = app.workspace_id();
  IF v_row.id IS NULL OR v_caller IS NULL THEN
    RETURN 'There is no such proposal.';
  END IF;
  IF v_row.team_id <> ALL (app.readable_team_ids('read')) THEN
    RETURN 'There is no such proposal.';
  END IF;
  IF v_row.status <> 'open' THEN
    RETURN 'This proposal is already ' || v_row.status || '.';
  END IF;
  SELECT a.kind INTO v_kind FROM app.actors a WHERE a.id = v_caller;
  IF v_kind IS DISTINCT FROM 'person' THEN
    RETURN 'Only a person applies a proposal. A bot can only propose.';
  END IF;
  IF NOT coalesce(app.lookup_can('team', v_row.team_id, 'manage'), false) THEN
    RETURN 'Only a team lead or a workspace admin can apply a proposal.';
  END IF;
  IF v_row.needs_admin AND coalesce(app.lookup_workspace_role() NOT IN ('owner', 'admin'), true) THEN
    RETURN 'Adding or removing a bot is for a workspace admin. A team lead can change a bot that already exists.';
  END IF;
  IF p_self THEN
    IF v_row.author_id <> v_caller THEN
      RETURN 'Only the author can propose and apply in one step.';
    END IF;
  ELSIF v_row.author_id = v_caller THEN
    IF app.proposals_other_approvers(v_row.team_id, v_row.needs_admin, v_caller) > 0 THEN
      RETURN 'You wrote this proposal, so another team lead or workspace admin applies it.';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- Make --------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION app.proposals_create(
  p_team_id uuid, p_path text, p_op text, p_title text, p_note text, p_content text, p_base_blob_sha text, p_base_commit_sha text,
  p_needs_admin boolean, p_diff text, p_added integer, p_removed integer, p_checks jsonb
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws       uuid := app.workspace_id();
  v_caller   uuid := app.actor();
  v_kind     text;
  v_archived timestamptz;
  v_team_ws  uuid;
  v_name     text;
  v_id       uuid := uuidv7();
BEGIN
  IF v_ws IS NULL OR v_caller IS NULL THEN
    RAISE EXCEPTION 'a proposal is made by a person or a bot' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT a.kind INTO v_kind FROM app.actors a WHERE a.id = v_caller AND a.workspace_id = v_ws;
  IF v_kind IS NULL OR v_kind NOT IN ('person', 'bot') THEN
    RAISE EXCEPTION 'a proposal is made by a person or a bot' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(app.lookup_can('team', p_team_id, 'post'), false) THEN
    RAISE EXCEPTION 'you cannot propose changes for this team' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.archived_at, t.workspace_id INTO v_archived, v_team_ws FROM app.teams t WHERE t.id = p_team_id;
  IF v_team_ws IS DISTINCT FROM v_ws THEN
    RAISE EXCEPTION 'no such team' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'This team is archived, so nothing can be proposed for it' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM app.proposals q WHERE q.team_id = p_team_id AND q.author_id = v_caller AND q.status = 'open') >= 50 THEN
    RAISE EXCEPTION 'You have 50 proposals waiting in this team. Withdraw one or wait for a decision.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_kind = 'person' THEN
    SELECT p.display_name INTO v_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id WHERE a.id = v_caller;
  ELSE
    SELECT coalesce(b.name, b.slug) INTO v_name FROM app.actors a JOIN app.bots b ON b.id = a.ref_id AND b.workspace_id = a.workspace_id WHERE a.id = v_caller;
  END IF;
  INSERT INTO app.proposals (id, workspace_id, team_id, author_id, author_kind, author_name, title, note, path, op, content, base_blob_sha, base_commit_sha,
                             needs_admin, diff, added, removed, checks)
    VALUES (v_id, v_ws, p_team_id, v_caller, v_kind, coalesce(nullif(v_name, ''), CASE v_kind WHEN 'bot' THEN 'A bot' ELSE 'Someone' END), p_title, coalesce(p_note, ''),
            p_path, p_op, p_content, p_base_blob_sha, p_base_commit_sha, p_needs_admin, p_diff, p_added, p_removed, coalesce(p_checks, '[]'::jsonb));
  RETURN v_id;
END
$$;

-- Decide ------------------------------------------------------------------------------------------------------------------------
-- 'applied' (the commit was made by the caller in the same transaction), 'rejected' (a lead or admin turns it down) or 'withdrawn' (its author takes it
-- back). Only an open proposal changes. Answers the decided row's id; raises no_data_found when there is none to decide.
CREATE FUNCTION app.proposals_decide(p_id uuid, p_status text, p_note text, p_commit_sha text, p_self boolean, p_checks jsonb) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_caller uuid := app.actor();
  v_row    app.proposals;
  v_why    text;
  v_name   text;
BEGIN
  IF p_status NOT IN ('applied', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'a proposal is applied, rejected or withdrawn' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_row FROM app.proposals WHERE id = p_id AND workspace_id = app.workspace_id() AND team_id = ANY (app.readable_team_ids('read')) FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'no such proposal' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION 'This proposal is already %.', v_row.status USING ERRCODE = 'check_violation';
  END IF;
  IF p_status = 'applied' THEN
    v_why := app.proposals_why_not(p_id, p_self);
    IF v_why IS NOT NULL THEN
      RAISE EXCEPTION '%', v_why USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_commit_sha IS NULL THEN
      RAISE EXCEPTION 'an applied proposal names its commit' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_status = 'rejected' THEN
    IF NOT coalesce(app.lookup_can('team', v_row.team_id, 'manage'), false) OR v_row.author_id = v_caller THEN
      RAISE EXCEPTION 'Only a team lead or workspace admin other than the author can reject a proposal; the author withdraws it.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF v_row.author_id <> v_caller THEN
      RAISE EXCEPTION 'Only the author can withdraw a proposal.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT p.display_name INTO v_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id WHERE a.id = v_caller AND a.kind = 'person';
  UPDATE app.proposals SET
      status = p_status, decided_at = now(), decided_by = v_caller, decided_by_name = coalesce(v_name, v_row.author_name),
      decision_note = nullif(p_note, ''), applied_commit_sha = CASE WHEN p_status = 'applied' THEN p_commit_sha END,
      self_applied = (p_status = 'applied' AND p_self), checks = coalesce(p_checks, checks)
    WHERE id = p_id;
  RETURN p_id;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.proposals_other_approvers(uuid, boolean, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.proposals_why_not(uuid, boolean) OWNER TO manythreads_system;
ALTER FUNCTION app.proposals_create(uuid, text, text, text, text, text, text, text, boolean, text, integer, integer, jsonb) OWNER TO manythreads_system;
ALTER FUNCTION app.proposals_decide(uuid, text, text, text, boolean, jsonb) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.proposals_other_approvers(uuid, boolean, uuid), app.proposals_why_not(uuid, boolean),
  app.proposals_create(uuid, text, text, text, text, text, text, text, boolean, text, integer, integer, jsonb),
  app.proposals_decide(uuid, text, text, text, boolean, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.proposals_other_approvers(uuid, boolean, uuid), app.proposals_why_not(uuid, boolean),
  app.proposals_create(uuid, text, text, text, text, text, text, text, boolean, text, integer, integer, jsonb),
  app.proposals_decide(uuid, text, text, text, boolean, jsonb) TO manythreads_app, manythreads_system;
