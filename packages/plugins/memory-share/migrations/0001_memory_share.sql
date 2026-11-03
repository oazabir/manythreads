-- memory-share 0001: outgoing memory shares (PLAN P8-22, P8-23; SPEC §12.3). Forward-only: never edit once applied.
-- (PLAN names this migration 0064; the repo numbers every plugin's migrations from 0001 inside the plugin's own folder, and so does this one.)
--
--  * memory_shares:      one row per `routines/shares/<slug>.yaml` of a team, rebuilt from `repo.committed` by the plugin's own subscriber (never by a request).
--                        It holds the validated definition and the few columns the scheduler and the pages read (mode, approval, cron, next run). `approval`
--                        is what the file says; `auto_allowed` is whether a lead or a workspace admin wrote it, which is what makes `auto` real.
--  * memory_share_links: one row per share and destination team. `requested` when the file names the destination; nothing is delivered until the
--                        destination's lead accepts (a later task writes `accepted`, `paused`, `revoked` through its own doors). `ended_reason` says whether
--                        the sending file dropped the destination (`removed`) or the destination ended it (`by_team`).
--  * memory_share_runs:  one row per digest the platform tried to build. `state` is where it is. `bundle` holds the digest's files and is the one column the
--                        request role is not granted (the delivery step reads it as the system role); `manifest` is the git hash of every concept sent (paths and
--                        hashes, no text), which the next run diffs against ("only what changed since the last delivery"). The approval is an `approvals` row (source `grant`, tool
--                        `memory.digest.send`) filed by `app.memory_share_request_approval`.
--
-- Every table carries `team_id` (the sending team), so the read policy is the hoisted team set. Runs name what was left out of a digest, so only the people who
-- manage the team read them.

CREATE TABLE app.memory_shares (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  slug           text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name           text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid', 'removed')),
  invalid_reason text        CHECK (invalid_reason IS NULL OR char_length(invalid_reason) <= 400),
  mode           text        NOT NULL DEFAULT 'summary' CHECK (mode IN ('full', 'summary')),
  approval       text        NOT NULL DEFAULT 'review' CHECK (approval IN ('review', 'auto')),
  auto_allowed   boolean     NOT NULL DEFAULT false,
  cron           text        CHECK (cron IS NULL OR char_length(cron) <= 120),
  next_run_at    timestamptz,
  approvers      text[]      NOT NULL DEFAULT '{role:lead}' CHECK (cardinality(approvers) <= 20),
  definition     jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(definition) <= 20000),
  definition_sha text        CHECK (definition_sha IS NULL OR definition_sha ~ '^[0-9a-f]{64}$'),
  defined_by     uuid        REFERENCES app.actors (id) ON DELETE SET NULL,
  commit_sha     text        CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40,64}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, slug),
  -- lets a run name its share and the share's team in one foreign key, so a run cannot say another team's share
  UNIQUE (id, team_id)
);
CREATE INDEX memory_shares_workspace ON app.memory_shares (workspace_id);
CREATE INDEX memory_shares_defined_by ON app.memory_shares (defined_by) WHERE defined_by IS NOT NULL;
-- the scheduler's tick: shares with a schedule that are due
CREATE INDEX memory_shares_due ON app.memory_shares (next_run_at) WHERE status = 'active' AND cron IS NOT NULL;
COMMENT ON TABLE app.memory_shares IS 'rls: team — T: the validated definition of a team''s outgoing share (routines/shares/<slug>.yaml), readable by whoever reads the team, rebuilt from repo.committed and written by the system role only.';

CREATE TABLE app.memory_share_links (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  share_id      uuid        NOT NULL,
  dest_team_id  uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  -- the destination's slug and name as they were when the file was last read: teams are visible only to their members and admins, and a lead of the sending
  -- team must still be able to see where a share goes
  dest_slug     text        NOT NULL CHECK (dest_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  dest_name     text        NOT NULL DEFAULT '' CHECK (char_length(dest_name) <= 200),
  state         text        NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'accepted', 'paused', 'revoked')),
  ended_reason  text        CHECK (ended_reason IS NULL OR ended_reason IN ('removed', 'by_team')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at   timestamptz,
  accepted_by   uuid        REFERENCES app.actors (id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (share_id, dest_team_id),
  FOREIGN KEY (share_id, team_id) REFERENCES app.memory_shares (id, team_id) ON DELETE CASCADE,
  CONSTRAINT memory_share_links_not_self CHECK (dest_team_id <> team_id),
  CONSTRAINT memory_share_links_accepted_has_time CHECK (state NOT IN ('accepted', 'paused') OR accepted_at IS NOT NULL)
);
CREATE INDEX memory_share_links_workspace ON app.memory_share_links (workspace_id);
CREATE INDEX memory_share_links_team ON app.memory_share_links (team_id);
CREATE INDEX memory_share_links_dest ON app.memory_share_links (dest_team_id);
CREATE INDEX memory_share_links_accepted_by ON app.memory_share_links (accepted_by) WHERE accepted_by IS NOT NULL;
COMMENT ON TABLE app.memory_share_links IS 'rls: team — T: one link per share and destination team, readable by whoever reads the sending team; written by the system role only (the accept step is a later task and writes through its own function).';

CREATE TABLE app.memory_share_runs (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  share_id      uuid        NOT NULL,
  trigger_kind  text        NOT NULL CHECK (trigger_kind IN ('schedule', 'manual')),
  state         text        NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'empty', 'blocked', 'awaiting_approval', 'ready', 'denied', 'expired', 'failed', 'sent')),
  state_reason  text        CHECK (state_reason IS NULL OR char_length(state_reason) <= 600),
  mode          text        NOT NULL CHECK (mode IN ('full', 'summary')),
  requested_by  uuid        REFERENCES app.actors (id) ON DELETE SET NULL,
  -- the digest: its period label (the folder name in the destination's inbox), a fingerprint of its files, the files themselves, and the hash of every concept sent
  period        text        CHECK (period IS NULL OR period ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,8})?$'),
  digest_sha    text        CHECK (digest_sha IS NULL OR digest_sha ~ '^[0-9a-f]{64}$'),
  bundle        jsonb       CHECK (bundle IS NULL OR (jsonb_typeof(bundle) = 'object' AND pg_column_size(bundle) <= 12000000)),
  bundle_bytes  integer     NOT NULL DEFAULT 0 CHECK (bundle_bytes >= 0),
  manifest      jsonb       CHECK (manifest IS NULL OR (jsonb_typeof(manifest) = 'object' AND pg_column_size(manifest) <= 400000)),
  -- what the pages read: the numbers, the included and left-out concepts (path, title, reason: never text), the diff and the destinations as they stood
  counts        jsonb       CHECK (counts IS NULL OR jsonb_typeof(counts) = 'object'),
  included      jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(included) = 'array' AND pg_column_size(included) <= 400000),
  excluded      jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(excluded) = 'array' AND pg_column_size(excluded) <= 400000),
  diff          jsonb       CHECK (diff IS NULL OR (jsonb_typeof(diff) = 'object' AND pg_column_size(diff) <= 400000)),
  destinations  jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(destinations) = 'array' AND pg_column_size(destinations) <= 40000),
  baseline_run_id uuid      REFERENCES app.memory_share_runs (id) ON DELETE SET NULL,
  approval_id   uuid        REFERENCES app.approvals (id) ON DELETE SET NULL,
  settled_by    uuid        REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  built_at      timestamptz,
  settled_at    timestamptz,
  sent_at       timestamptz,
  FOREIGN KEY (share_id, team_id) REFERENCES app.memory_shares (id, team_id) ON DELETE CASCADE,
  CONSTRAINT memory_share_runs_ready_has_digest CHECK (state NOT IN ('awaiting_approval', 'ready', 'sent') OR (digest_sha IS NOT NULL AND bundle IS NOT NULL AND manifest IS NOT NULL)),
  CONSTRAINT memory_share_runs_sent_has_time CHECK (state <> 'sent' OR sent_at IS NOT NULL)
);
CREATE INDEX memory_share_runs_workspace ON app.memory_share_runs (workspace_id);
CREATE INDEX memory_share_runs_team ON app.memory_share_runs (team_id, id DESC);
CREATE INDEX memory_share_runs_share ON app.memory_share_runs (share_id, id DESC);
CREATE INDEX memory_share_runs_requested_by ON app.memory_share_runs (requested_by) WHERE requested_by IS NOT NULL;
CREATE INDEX memory_share_runs_baseline ON app.memory_share_runs (baseline_run_id) WHERE baseline_run_id IS NOT NULL;
CREATE INDEX memory_share_runs_approval ON app.memory_share_runs (approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX memory_share_runs_settled_by ON app.memory_share_runs (settled_by) WHERE settled_by IS NOT NULL;
-- one digest is built at a time per share; the delta basis is "the last run that was sent"
CREATE UNIQUE INDEX memory_share_runs_one_building ON app.memory_share_runs (share_id) WHERE state = 'building';
CREATE INDEX memory_share_runs_sent ON app.memory_share_runs (share_id, sent_at DESC) WHERE state = 'sent';
CREATE INDEX memory_share_runs_waiting ON app.memory_share_runs (approval_id) WHERE state = 'awaiting_approval';
COMMENT ON TABLE app.memory_share_runs IS 'rls: team — T: one digest the platform tried to build for a share; readable by the people who manage the sending team (it names what was left out), a lead or admin starts one (state building), everything else is the system role; the digest files (`bundle`) are not granted to the request role.';

-- RLS --------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.memory_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_shares_select ON app.memory_shares FOR SELECT USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY memory_shares_system ON app.memory_shares FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.memory_shares TO manythreads_app;

ALTER TABLE app.memory_share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_share_links FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_share_links_select ON app.memory_share_links FOR SELECT USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY memory_share_links_system ON app.memory_share_links FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.memory_share_links TO manythreads_app;

ALTER TABLE app.memory_share_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_share_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_share_runs_select ON app.memory_share_runs FOR SELECT USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]));
-- a lead or admin starts a run by hand: it begins as `building`, as themselves, and the system role does the rest
CREATE POLICY memory_share_runs_insert ON app.memory_share_runs FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
      AND requested_by = (SELECT app.actor())
      AND trigger_kind = 'manual' AND state = 'building'
      AND bundle IS NULL AND manifest IS NULL AND approval_id IS NULL AND digest_sha IS NULL));
CREATE POLICY memory_share_runs_system ON app.memory_share_runs FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY memory_share_runs_delete ON app.memory_share_runs FOR DELETE USING ((SELECT app.is_system()));
-- everything but the digest files (the delivery step reads those as the system role); the hash list (`manifest`: paths and git hashes, no text) is what the preview diffs against
GRANT SELECT (id, workspace_id, team_id, share_id, trigger_kind, state, state_reason, mode, requested_by, period, digest_sha, bundle_bytes, manifest, counts, included, excluded, diff,
              destinations, baseline_run_id, approval_id, settled_by, created_at, updated_at, built_at, settled_at, sent_at)
  ON app.memory_share_runs TO manythreads_app;
GRANT INSERT (workspace_id, team_id, share_id, trigger_kind, state, mode, requested_by) ON app.memory_share_runs TO manythreads_app;

-- The approval of a digest ------------------------------------------------------------------------------------------------------------
-- Files the Approvals row for a built digest: source `grant`, tool `memory.digest.send`, no bot and no run behind it (`approvals_request_task` is the model: that door
-- is for two other sources). The caller is the system role only (the build job). The run must be the sending team's own and still `building`; the requester is the
-- person who asked (a run by hand) or the person who wrote the share's file (a scheduled one), and can never decide it. `p_approvers` is the share's list:
-- `role:lead` means the team's leads and the workspace's owners and admins; any other `role:<tag>` and `person:<id>` name exactly who may decide. The row's real call is a
-- hand-back: approving does not run anything here, it only marks the run `ready` (app.memory_share_settle).
CREATE FUNCTION app.memory_share_request_approval(p_run_id uuid, p_requester uuid, p_summary text, p_args_preview jsonb, p_approvers text[]) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_run     record;
  v_id      uuid;
  v_name    text;
  v_roles   jsonb;
  v_people  jsonb;
  v_leads   boolean;
  v_key     text;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the platform files a digest approval' USING ERRCODE = '42501';
  END IF;
  SELECT r.id, r.workspace_id, r.team_id, r.state, r.digest_sha, r.approval_id INTO v_run FROM app.memory_share_runs r WHERE r.id = p_run_id FOR UPDATE;
  -- asking twice for the same run is one approval
  IF FOUND AND v_run.approval_id IS NOT NULL THEN RETURN v_run.approval_id; END IF;
  IF NOT FOUND OR v_run.state <> 'building' OR v_run.digest_sha IS NULL THEN
    RAISE EXCEPTION 'that digest is not ready to be approved' USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM app.actors a WHERE a.id = p_requester AND a.workspace_id = v_run.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the requester is not an actor of this workspace' USING ERRCODE = '23503';
  END IF;
  SELECT coalesce(p.display_name, b.name, 'someone') INTO v_name
    FROM app.actors k
    LEFT JOIN app.people p ON p.id = k.ref_id AND k.kind = 'person'
    LEFT JOIN app.bots b ON b.id = k.ref_id AND k.kind = 'bot'
   WHERE k.id = p_requester;
  v_roles := coalesce((SELECT jsonb_agg(DISTINCT x) FROM unnest(p_approvers) AS x WHERE x LIKE 'role:%' AND x <> 'role:lead'), '[]'::jsonb);
  v_people := coalesce((SELECT jsonb_agg(DISTINCT substr(x, 8)) FROM unnest(p_approvers) AS x WHERE x LIKE 'person:%'), '[]'::jsonb);
  v_leads := 'role:lead' = ANY (p_approvers) OR (jsonb_array_length(v_roles) = 0 AND jsonb_array_length(v_people) = 0);
  v_key := 'share-run:' || p_run_id::text;
  INSERT INTO app.approvals (workspace_id, team_id, source, tool, summary, args_preview, args_truncated, resume, approver_scope,
                             requester_id, requester_name, bot_id, run_id, channel_id, thread_root_id, dedupe_key)
  VALUES (v_run.workspace_id, v_run.team_id, 'grant', 'memory.digest.send', left(coalesce(p_summary, 'Send a memory digest'), 300), coalesce(p_args_preview, '{}'::jsonb), false,
          jsonb_build_object('kind', 'handoff', 'payload', jsonb_build_object('op', 'memory_digest_send', 'runId', p_run_id)),
          jsonb_build_object('roles', v_roles, 'people', v_people, 'leads', v_leads),
          p_requester, coalesce(v_name, 'someone'), NULL, NULL, NULL, NULL, v_key)
  RETURNING id INTO v_id;
  UPDATE app.memory_share_runs SET approval_id = v_id WHERE id = p_run_id;
  RETURN v_id;
END
$$;

-- A decision on a digest's approval moves its run: approved -> `ready` (the digest is built, checked and approved; delivering it is the next task's), denied -> `denied`.
-- Only the platform (the event subscriber) calls it; it answers the run it moved, and nothing at all for an approval that is not a digest's, that was already
-- applied, or that was not decided the way it was told. The approval's own outcome is set to `ran` so the Approvals sweep does not call an approved digest "never started".
CREATE FUNCTION app.memory_share_settle(p_approval_id uuid, p_decision text)
  RETURNS TABLE (o_run_id uuid, o_share_id uuid, o_team_id uuid, o_workspace_id uuid, o_outcome text, o_decider uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_status text;
  v_decider uuid;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the platform settles a digest' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approved', 'denied') THEN
    RAISE EXCEPTION 'a decision is approved or denied' USING ERRCODE = '22023';
  END IF;
  SELECT a.status, d.decider_id INTO v_status, v_decider
    FROM app.approvals a LEFT JOIN app.approval_decisions d ON d.approval_id = a.id
   WHERE a.id = p_approval_id AND a.tool = 'memory.digest.send' AND a.source = 'grant';
  IF NOT FOUND OR v_status <> p_decision THEN RETURN; END IF;
  RETURN QUERY
  WITH moved AS (
    UPDATE app.memory_share_runs r
       SET state = CASE WHEN p_decision = 'approved' THEN 'ready' ELSE 'denied' END, settled_by = v_decider, settled_at = now(), updated_at = now()
     WHERE r.approval_id = p_approval_id AND r.state = 'awaiting_approval'
     RETURNING r.id, r.share_id, r.team_id, r.workspace_id, r.state)
  SELECT m.id, m.share_id, m.team_id, m.workspace_id, m.state, v_decider FROM moved m;
  IF FOUND AND p_decision = 'approved' THEN
    UPDATE app.approvals SET outcome = 'ran', outcome_detail = 'Approved. The digest is ready to be delivered to the teams that accepted it.' WHERE id = p_approval_id AND outcome = 'queued';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION app.memory_share_request_approval(uuid, uuid, text, jsonb, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.memory_share_settle(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_share_request_approval(uuid, uuid, text, jsonb, text[]) TO manythreads_system;
GRANT EXECUTE ON FUNCTION app.memory_share_settle(uuid, text) TO manythreads_system;

-- Owned by the system role like every other definer function.
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.memory_share_request_approval(uuid, uuid, text, jsonb, text[]) OWNER TO manythreads_system;
ALTER FUNCTION app.memory_share_settle(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
