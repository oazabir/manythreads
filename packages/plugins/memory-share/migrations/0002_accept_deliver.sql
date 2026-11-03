-- memory-share 0002: accept, pause, revoke, the workspace switch and delivery (PLAN P8-24; SPEC §12.3). Forward-only: never edit once applied.
--
--  * memory_share_links.approval_id    the Approvals row (source `grant`, tool `memory.share.accept`) that asks the destination team's leads to accept. Filed by
--                                      app.memory_share_request_accept, settled by app.memory_share_settle_accept (the same pattern as the digest's approval in 0001).
--  * memory_sharing_settings           one row per workspace: the "Memory sharing" switch. No row means on. Readable by every member of the workspace, written by owners and
--                                      admins (the link-preview settings are the model). Off, nothing is built, delivered or imported as a share.
--  * memory_share_deliveries           one row per digest handed to one destination team: UNIQUE (share, destination, digest fingerprint) is what makes delivery idempotent.
--                                      It names the inbox item the digest became. The digest's files stay on the run (`memory_share_runs.bundle`); the importer reads them
--                                      from there by the item's id, so nothing a caller supplies is ever the content that is filed.
--  * app.deliver_inbox_item            the only door that puts a digest into another team's inbox.
--  * app.memory_share_link_act         pause, resume or end a link: the destination team's call.
--  * app.memory_share_incoming         the shares a team receives (a destination cannot read the sender's tables, so it asks this).
--
-- Definer functions run as the system role, where app.is_system() and app.is_workspace_admin() are TRUE for every caller. Each therefore checks its caller with the lookup
-- functions (app.lookup_can_team, app.lookup_team_role, app.lookup_workspace_role), which answer NULL for an outsider, wrapped in coalesce(..., false): `NOT NULL` is NULL, not true.

ALTER TABLE app.memory_share_links ADD COLUMN approval_id uuid REFERENCES app.approvals (id) ON DELETE SET NULL;
CREATE INDEX memory_share_links_approval ON app.memory_share_links (approval_id) WHERE approval_id IS NOT NULL;

-- The workspace switch ----------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.memory_sharing_settings (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces (id) ON DELETE CASCADE,
  enabled      boolean     NOT NULL DEFAULT true,
  changed_by   uuid        REFERENCES app.actors (id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_sharing_settings_changed_by ON app.memory_sharing_settings (changed_by) WHERE changed_by IS NOT NULL;
COMMENT ON TABLE app.memory_sharing_settings IS 'rls: workspace — W: the "Memory sharing" switch (no row means on); readable by every member of the workspace, written by workspace owners and admins.';
ALTER TABLE app.memory_sharing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_sharing_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_sharing_settings_select ON app.memory_sharing_settings FOR SELECT
  USING ((SELECT app.is_system()) OR workspace_id = (SELECT app.workspace_id()));
CREATE POLICY memory_sharing_settings_insert ON app.memory_sharing_settings FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY memory_sharing_settings_update ON app.memory_sharing_settings FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT ON app.memory_sharing_settings TO manythreads_app;
GRANT INSERT (workspace_id, enabled, changed_by, updated_at) ON app.memory_sharing_settings TO manythreads_app;
GRANT UPDATE (enabled, changed_by, updated_at) ON app.memory_sharing_settings TO manythreads_app;

-- Deliveries ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.memory_share_deliveries (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  share_id      uuid        NOT NULL,
  run_id        uuid        NOT NULL REFERENCES app.memory_share_runs (id) ON DELETE CASCADE,
  dest_team_id  uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  -- the sending team's slug as it was at delivery: it names the folder the digest is filed under (`memory/shared/<from>/`)
  from_slug     text        NOT NULL CHECK (from_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  digest_sha    text        NOT NULL CHECK (digest_sha ~ '^[0-9a-f]{64}$'),
  period        text        NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,8})?$'),
  item_id       uuid        REFERENCES app.memory_inbox_items (id) ON DELETE SET NULL,
  files         integer     NOT NULL CHECK (files >= 0),
  bytes         integer     NOT NULL CHECK (bytes >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- one digest (by its fingerprint) goes once to one destination for one share: a replay finds this row instead of writing a second item
  UNIQUE (share_id, dest_team_id, digest_sha),
  FOREIGN KEY (share_id, team_id) REFERENCES app.memory_shares (id, team_id) ON DELETE CASCADE,
  CONSTRAINT memory_share_deliveries_not_self CHECK (dest_team_id <> team_id)
);
CREATE INDEX memory_share_deliveries_workspace ON app.memory_share_deliveries (workspace_id);
CREATE INDEX memory_share_deliveries_team ON app.memory_share_deliveries (team_id, id DESC);
CREATE INDEX memory_share_deliveries_run ON app.memory_share_deliveries (run_id);
CREATE INDEX memory_share_deliveries_dest ON app.memory_share_deliveries (dest_team_id, id DESC);
CREATE INDEX memory_share_deliveries_item ON app.memory_share_deliveries (item_id) WHERE item_id IS NOT NULL;
COMMENT ON TABLE app.memory_share_deliveries IS 'rls: team — T: one digest handed to one destination team (idempotent per share, destination and content hash); readable by the people who manage the sending team, written only by app.deliver_inbox_item (system role).';
ALTER TABLE app.memory_share_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_share_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_share_deliveries_select ON app.memory_share_deliveries FOR SELECT
  USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]));
CREATE POLICY memory_share_deliveries_system ON app.memory_share_deliveries FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.memory_share_deliveries TO manythreads_app;

-- Deliver --------------------------------------------------------------------------------------------------------------------------------------
-- Hands one approved digest to one destination team's inbox. The caller is the platform (the delivery job) or a person who manages the SENDING team; anyone else, including
-- a lead of the destination, gets 42501. Everything else is checked here, for every caller:
--   * the run is the sending team's own, belongs to an active share of that team, and is `ready` (approved) or `sent` (a replay);
--   * the workspace's "Memory sharing" switch is on;
--   * the destination is one of the teams recorded on the run (`destinations`) when its digest was built, i.e. one the approver was shown;
--   * the destination has an `accepted` link to this share (requested, paused and revoked deliver nothing), is in the same workspace and is not archived.
-- The item it writes is an authenticated one: origin `share`, sender check `pass`, kind `bundle`, named `digests/<from>/<period>`, with no original in blob storage (the digest is the
-- run's own bundle, read by the importer through the delivery row). The same digest to the same destination is the same delivery (`duplicate`), never a second item.
CREATE FUNCTION app.deliver_inbox_item(p_run_id uuid, p_dest_team_id uuid)
  RETURNS TABLE (o_delivery_id uuid, o_item_id uuid, o_duplicate boolean, o_team_id uuid, o_dest_team_id uuid, o_share_id uuid, o_workspace_id uuid, o_digest_sha text, o_period text, o_files integer, o_bytes integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_run      record;
  v_share    record;
  v_link     record;
  v_dest     record;
  v_from     record;
  v_existing record;
  v_item     uuid;
  v_delivery uuid;
  v_files    integer;
  v_found    boolean;
BEGIN
  SELECT r.id, r.workspace_id, r.team_id, r.share_id, r.state, r.digest_sha, r.period, r.bundle_bytes, r.bundle IS NOT NULL AS has_bundle, r.destinations,
         CASE WHEN r.bundle IS NULL THEN 0 ELSE (SELECT count(*)::integer FROM jsonb_object_keys(r.bundle)) END AS file_count
    INTO v_run FROM app.memory_share_runs r WHERE r.id = p_run_id FOR UPDATE;
  v_found := FOUND;
  -- who may call: the platform's own job, or a person who manages the sending team. A run that does not exist and a run the caller may not use answer the same.
  IF session_user <> 'manythreads_system' THEN
    IF NOT v_found OR NOT coalesce(app.lookup_can_team(v_run.team_id, 'manage'), false) THEN
      RAISE EXCEPTION 'only the team that sends a digest may deliver it' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NOT v_found THEN
    RAISE EXCEPTION 'no such digest' USING ERRCODE = '55000';
  END IF;
  IF v_run.state NOT IN ('ready', 'sent') OR NOT v_run.has_bundle OR v_run.digest_sha IS NULL OR v_run.period IS NULL THEN
    RAISE EXCEPTION 'that digest is not approved for delivery' USING ERRCODE = '55000';
  END IF;
  SELECT s.id, s.status INTO v_share FROM app.memory_shares s WHERE s.id = v_run.share_id AND s.team_id = v_run.team_id;
  IF NOT FOUND OR v_share.status <> 'active' THEN
    RAISE EXCEPTION 'that share is not active' USING ERRCODE = '55000';
  END IF;
  IF NOT coalesce((SELECT st.enabled FROM app.memory_sharing_settings st WHERE st.workspace_id = v_run.workspace_id), true) THEN
    RAISE EXCEPTION 'memory sharing is switched off for this workspace' USING ERRCODE = '55000';
  END IF;
  -- only a team the approver was shown can have the digest: the destinations recorded on the run when it was built (a team that accepted since was not named in that decision)
  IF jsonb_typeof(v_run.destinations) <> 'array'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_run.destinations) e WHERE e ->> 'teamId' = p_dest_team_id::text) THEN
    RAISE EXCEPTION 'that team was not one of the teams this digest was approved for' USING ERRCODE = '55000';
  END IF;
  SELECT l.id, l.state INTO v_link FROM app.memory_share_links l
   WHERE l.share_id = v_run.share_id AND l.team_id = v_run.team_id AND l.dest_team_id = p_dest_team_id FOR UPDATE;
  IF NOT FOUND OR v_link.state <> 'accepted' THEN
    RAISE EXCEPTION 'that team has not accepted this share, or has paused or ended it' USING ERRCODE = '55000';
  END IF;
  SELECT t.id, t.archived_at INTO v_dest FROM app.teams t WHERE t.id = p_dest_team_id AND t.workspace_id = v_run.workspace_id;
  IF NOT FOUND OR v_dest.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'the receiving team is archived or does not exist' USING ERRCODE = '55000';
  END IF;
  SELECT t.slug INTO v_from FROM app.teams t WHERE t.id = v_run.team_id AND t.workspace_id = v_run.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the sending team does not exist' USING ERRCODE = '55000';
  END IF;

  -- a replay: the same digest to the same destination is the delivery that is already there
  SELECT d.id, d.item_id, d.files, d.bytes INTO v_existing
    FROM app.memory_share_deliveries d WHERE d.share_id = v_run.share_id AND d.dest_team_id = p_dest_team_id AND d.digest_sha = v_run.digest_sha;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.id, v_existing.item_id, true, v_run.team_id, p_dest_team_id, v_run.share_id, v_run.workspace_id, v_run.digest_sha, v_run.period, v_existing.files, v_existing.bytes;
    RETURN;
  END IF;

  v_files := v_run.file_count;
  INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name, team_only, sender, sender_check)
  VALUES (v_run.workspace_id, p_dest_team_id, 'share', 'queued', 'hold', 'bundle', left('digests/' || v_from.slug || '/' || v_run.period, 200), v_run.bundle_bytes, v_run.digest_sha,
          NULL, NULL, NULL, false, v_from.slug, 'pass')
  RETURNING id INTO v_item;
  INSERT INTO app.memory_share_deliveries (workspace_id, team_id, share_id, run_id, dest_team_id, from_slug, digest_sha, period, item_id, files, bytes)
  VALUES (v_run.workspace_id, v_run.team_id, v_run.share_id, v_run.id, p_dest_team_id, v_from.slug, v_run.digest_sha, v_run.period, v_item, v_files, v_run.bundle_bytes)
  RETURNING id INTO v_delivery;
  RETURN QUERY SELECT v_delivery, v_item, false, v_run.team_id, p_dest_team_id, v_run.share_id, v_run.workspace_id, v_run.digest_sha, v_run.period, v_files, v_run.bundle_bytes;
END
$$;

-- Accept ---------------------------------------------------------------------------------------------------------------------------------------
-- Files the Approvals row that asks the destination team's leads to accept a share ("Support wants to share its memory with you"). The row belongs to the DESTINATION team, so
-- its leads (and the workspace's owners and admins) see and decide it; the requester is the person who wrote the share's file and can never decide it. Platform only (the share
-- loader, and the tick that asks again for a link that has no row). Asking twice while a row is open is one row. The preview names the sending team, the share, its form and its
-- filters; it never holds any text of a concept.
CREATE FUNCTION app.memory_share_request_accept(p_link_id uuid, p_requester uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_link   record;
  v_share  record;
  v_from   record;
  v_dest   record;
  v_id     uuid;
  v_name   text;
  v_asked  integer;
  v_summary text;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the platform asks a team to accept a share' USING ERRCODE = '42501';
  END IF;
  SELECT l.id, l.workspace_id, l.team_id, l.share_id, l.dest_team_id, l.state, l.approval_id INTO v_link FROM app.memory_share_links l WHERE l.id = p_link_id FOR UPDATE;
  IF NOT FOUND OR v_link.state <> 'requested' THEN
    RAISE EXCEPTION 'that link is not waiting for an answer' USING ERRCODE = '55000';
  END IF;
  IF v_link.approval_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.approvals a WHERE a.id = v_link.approval_id AND a.status = 'pending' AND a.expires_at > now()) THEN
    RETURN v_link.approval_id;
  END IF;
  SELECT s.name, s.mode, s.status, s.definition INTO v_share FROM app.memory_shares s WHERE s.id = v_link.share_id AND s.team_id = v_link.team_id;
  IF NOT FOUND OR v_share.status <> 'active' THEN
    RAISE EXCEPTION 'that share is not active' USING ERRCODE = '55000';
  END IF;
  SELECT t.name, t.slug INTO v_from FROM app.teams t WHERE t.id = v_link.team_id AND t.workspace_id = v_link.workspace_id;
  SELECT t.name, t.archived_at INTO v_dest FROM app.teams t WHERE t.id = v_link.dest_team_id AND t.workspace_id = v_link.workspace_id;
  IF NOT FOUND OR v_dest.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'the receiving team is archived or does not exist' USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM app.actors a WHERE a.id = p_requester AND a.workspace_id = v_link.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the requester is not an actor of this workspace' USING ERRCODE = '23503';
  END IF;
  SELECT coalesce(p.display_name, b.name, 'someone') INTO v_name
    FROM app.actors k
    LEFT JOIN app.people p ON p.id = k.ref_id AND k.kind = 'person'
    LEFT JOIN app.bots b ON b.id = k.ref_id AND k.kind = 'bot'
   WHERE k.id = p_requester;
  SELECT count(*)::integer INTO v_asked FROM app.approvals a WHERE a.tool = 'memory.share.accept' AND a.dedupe_key LIKE 'share-accept:' || p_link_id::text || ':%';
  v_summary := left('Let ' || coalesce(v_from.name, 'another team') || ' share its memory with ' || coalesce(v_dest.name, 'this team') || ': “' || left(v_share.name, 80) || '”', 300);
  INSERT INTO app.approvals (workspace_id, team_id, source, tool, summary, args_preview, args_truncated, resume, approver_scope,
                             requester_id, requester_name, bot_id, run_id, channel_id, thread_root_id, dedupe_key)
  VALUES (v_link.workspace_id, v_link.dest_team_id, 'grant', 'memory.share.accept', v_summary,
          jsonb_build_object('from', coalesce(v_from.name, ''), 'share', left(v_share.name, 120), 'mode', v_share.mode,
                             'select', coalesce(v_share.definition -> 'select', '{}'::jsonb), 'when', coalesce(v_share.definition -> 'when', '"manual"'::jsonb),
                             'approval', coalesce(v_share.definition ->> 'approval', 'review')),
          false,
          jsonb_build_object('kind', 'handoff', 'payload', jsonb_build_object('op', 'memory_share_accept', 'linkId', p_link_id)),
          jsonb_build_object('roles', '[]'::jsonb, 'people', '[]'::jsonb, 'leads', true),
          p_requester, coalesce(v_name, 'someone'), NULL, NULL, NULL, NULL, 'share-accept:' || p_link_id::text || ':' || (v_asked + 1)::text)
  RETURNING id INTO v_id;
  UPDATE app.memory_share_links SET approval_id = v_id, updated_at = now() WHERE id = p_link_id;
  RETURN v_id;
END
$$;

-- A decision on an accept row moves its link: approved -> `accepted` (by the person who decided), denied -> `revoked` ended by the team. Platform only (the event subscriber). It answers the
-- link it moved, and nothing for a row that is not an accept row, that was already applied, or whose link has since moved on (the sending file dropped the team, say). An approved row's
-- outcome is set to `ran` so the Approvals sweep does not call it "never started".
CREATE FUNCTION app.memory_share_settle_accept(p_approval_id uuid, p_decision text)
  RETURNS TABLE (o_link_id uuid, o_share_id uuid, o_team_id uuid, o_dest_team_id uuid, o_workspace_id uuid, o_to text, o_ended text, o_decider uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_status  text;
  v_team    uuid;
  v_decider uuid;
  v_moved   boolean;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the platform settles an accept' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approved', 'denied') THEN
    RAISE EXCEPTION 'a decision is approved or denied' USING ERRCODE = '22023';
  END IF;
  SELECT a.status, a.team_id, d.decider_id INTO v_status, v_team, v_decider
    FROM app.approvals a LEFT JOIN app.approval_decisions d ON d.approval_id = a.id
   WHERE a.id = p_approval_id AND a.tool = 'memory.share.accept' AND a.source = 'grant';
  IF NOT FOUND OR v_status <> p_decision THEN RETURN; END IF;
  RETURN QUERY
  WITH moved AS (
    UPDATE app.memory_share_links l
       SET state = CASE WHEN p_decision = 'approved' THEN 'accepted' ELSE 'revoked' END,
           ended_reason = CASE WHEN p_decision = 'approved' THEN NULL ELSE 'by_team' END,
           accepted_at = CASE WHEN p_decision = 'approved' THEN now() ELSE l.accepted_at END,
           accepted_by = CASE WHEN p_decision = 'approved' THEN v_decider ELSE l.accepted_by END,
           updated_at = now()
     WHERE l.approval_id = p_approval_id AND l.state = 'requested' AND l.dest_team_id = v_team
     RETURNING l.id, l.share_id, l.team_id, l.dest_team_id, l.workspace_id, l.state, l.ended_reason)
  SELECT m.id, m.share_id, m.team_id, m.dest_team_id, m.workspace_id, m.state, m.ended_reason, v_decider FROM moved m;
  v_moved := FOUND;
  IF p_decision = 'approved' THEN
    UPDATE app.approvals SET outcome = 'ran',
           outcome_detail = CASE WHEN v_moved THEN 'Accepted. The other team can now send its digests here.' ELSE 'Approved, but the share had already been ended.' END
     WHERE id = p_approval_id AND outcome = 'queued';
  END IF;
END
$$;

-- Pause, resume, end -------------------------------------------------------------------------------------------------------------------------
-- The destination team's call: a lead of the destination team or a workspace owner or admin. `p_dest_team_id` is the team the caller addressed; a link that is not that team's answers
-- the same as one that does not exist. Pause: accepted -> paused (nothing arrives until it is resumed). Resume: paused -> accepted. End: requested, accepted or paused -> revoked,
-- by the team (it stays ended for this share: naming the team in the file again does not reopen it; the sender writes a new share to ask again, and the team must accept that one).
CREATE FUNCTION app.memory_share_link_act(p_link_id uuid, p_dest_team_id uuid, p_action text)
  RETURNS TABLE (o_link_id uuid, o_share_id uuid, o_team_id uuid, o_dest_team_id uuid, o_workspace_id uuid, o_from text, o_to text, o_ended text, o_actor uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_link record;
  v_to   text;
BEGIN
  IF p_action NOT IN ('pause', 'resume', 'revoke') THEN
    RAISE EXCEPTION 'an action is pause, resume or revoke' USING ERRCODE = '22023';
  END IF;
  IF NOT coalesce(app.lookup_can_team(p_dest_team_id, 'manage'), false) THEN
    RAISE EXCEPTION 'only a lead of the receiving team may change this' USING ERRCODE = '42501';
  END IF;
  SELECT l.id, l.share_id, l.team_id, l.dest_team_id, l.workspace_id, l.state INTO v_link
    FROM app.memory_share_links l WHERE l.id = p_link_id AND l.dest_team_id = p_dest_team_id AND l.workspace_id = app.workspace_id() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such share for this team' USING ERRCODE = 'P0002';
  END IF;
  IF p_action = 'pause' THEN
    IF v_link.state <> 'accepted' THEN RAISE EXCEPTION 'only a share this team has accepted can be paused' USING ERRCODE = '55000'; END IF;
    v_to := 'paused';
  ELSIF p_action = 'resume' THEN
    IF v_link.state <> 'paused' THEN RAISE EXCEPTION 'only a paused share can be resumed' USING ERRCODE = '55000'; END IF;
    v_to := 'accepted';
  ELSE
    IF v_link.state = 'revoked' THEN RAISE EXCEPTION 'this share has already ended' USING ERRCODE = '55000'; END IF;
    v_to := 'revoked';
  END IF;
  UPDATE app.memory_share_links SET state = v_to, ended_reason = CASE WHEN v_to = 'revoked' THEN 'by_team' ELSE ended_reason END, updated_at = now() WHERE id = v_link.id;
  RETURN QUERY SELECT v_link.id, v_link.share_id, v_link.team_id, v_link.dest_team_id, v_link.workspace_id, v_link.state, v_to,
                      CASE WHEN v_to = 'revoked' THEN 'by_team' ELSE NULL END, app.actor();
END
$$;

-- What a team receives ------------------------------------------------------------------------------------------------------------------------
-- The shares other teams send to `p_dest_team_id`, for whoever can read that team. People outside the sending team cannot read its tables, so this is the one view of a link
-- from the other side: the sending team's name, the share's name and form, the state, and when a digest last arrived. Shares the sender has removed are left out.
CREATE FUNCTION app.memory_share_incoming(p_dest_team_id uuid)
  RETURNS TABLE (o_link_id uuid, o_share_id uuid, o_from_team_id uuid, o_from_slug text, o_from_name text, o_share_name text, o_mode text, o_state text, o_ended text,
                 o_approval_id uuid, o_requested_at timestamptz, o_accepted_at timestamptz, o_last_delivered_at timestamptz, o_deliveries integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT l.id, l.share_id, l.team_id, t.slug, t.name, s.name, s.mode, l.state, l.ended_reason, l.approval_id, l.requested_at, l.accepted_at,
         (SELECT max(d.created_at) FROM app.memory_share_deliveries d WHERE d.share_id = l.share_id AND d.dest_team_id = l.dest_team_id),
         (SELECT count(*)::integer FROM app.memory_share_deliveries d WHERE d.share_id = l.share_id AND d.dest_team_id = l.dest_team_id)
    FROM app.memory_share_links l
    JOIN app.memory_shares s ON s.id = l.share_id AND s.team_id = l.team_id
    JOIN app.teams t ON t.id = l.team_id
   WHERE l.dest_team_id = p_dest_team_id
     AND l.workspace_id = app.workspace_id()
     AND coalesce(app.lookup_can_team(p_dest_team_id, 'read'), false)
     AND s.status <> 'removed'
     AND NOT (l.state = 'revoked' AND l.ended_reason = 'removed')
   ORDER BY t.name, s.name, l.id
$$;

REVOKE ALL ON FUNCTION app.deliver_inbox_item(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.memory_share_request_accept(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.memory_share_settle_accept(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.memory_share_link_act(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.memory_share_incoming(uuid) FROM PUBLIC;
-- deliver and the link doors are callable by the request role too: each checks its own caller
GRANT EXECUTE ON FUNCTION app.deliver_inbox_item(uuid, uuid) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.memory_share_link_act(uuid, uuid, text) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.memory_share_incoming(uuid) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.memory_share_request_accept(uuid, uuid) TO manythreads_system;
GRANT EXECUTE ON FUNCTION app.memory_share_settle_accept(uuid, text) TO manythreads_system;

-- Owned by the system role like every other definer function.
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.deliver_inbox_item(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.memory_share_request_accept(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.memory_share_settle_accept(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.memory_share_link_act(uuid, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.memory_share_incoming(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
