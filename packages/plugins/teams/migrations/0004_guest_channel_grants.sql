-- teams plugin 0004 (P3-16): a guest invitation's channel grants are applied when it is accepted. The invitation recorded them in
-- `grant_spec.channels` (`{teamId, teamSlug, channel, permission?}`); accepting now writes ACL entries (resource_type 'channel',
-- subject the new person) for each channel that exists: 'read', plus 'post' when the grant asks for it. Without a grant the guest
-- sees nothing (criterion 3: Lena sees exactly that channel). Forward-only: never edit once applied. CREATE OR REPLACE keeps the
-- owner (manythreads_system) and the grants of 0001.

CREATE OR REPLACE FUNCTION app.teams_invitation_accept(p_token_hash bytea, p_name text) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  inv            app.invitations;
  v_person       uuid;
  v_status       text;
  v_actor        uuid;
  v_created      boolean := false;
  v_ws_role      text;
  v_team_role    text;
  v_event        uuid := uuidv7();
  v_prev         text;
  v_inviter_adm  boolean;
  g              jsonb;
  v_chan         uuid;
  v_grants       integer := 0;
BEGIN
  SELECT i.* INTO inv FROM app.invitations i
  WHERE i.token_hash = p_token_hash
  ORDER BY (i.accepted_at IS NULL) DESC, i.created_at DESC LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF inv.accepted_at IS NOT NULL OR inv.expires_at <= now() THEN
    RETURN jsonb_build_object('outcome', 'gone');
  END IF;

  -- The inviter's authority at accept time.
  SELECT EXISTS (
    SELECT 1 FROM app.people p JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id
    WHERE p.id = inv.invited_by AND p.workspace_id = inv.workspace_id AND p.status = 'active' AND wm.role IN ('owner', 'admin')
  ) INTO v_inviter_adm;
  IF inv.team_id IS NOT NULL AND inv.invited_by IS NOT NULL AND NOT v_inviter_adm AND NOT EXISTS (
    SELECT 1 FROM app.team_members tm
    JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' AND a.ref_id = inv.invited_by
    JOIN app.people p ON p.id = a.ref_id AND p.status = 'active'
    WHERE tm.team_id = inv.team_id AND tm.role = 'lead'
  ) THEN
    RETURN jsonb_build_object('outcome', 'gone');
  END IF;

  SELECT p.id, p.status INTO v_person, v_status
  FROM app.people p WHERE p.workspace_id = inv.workspace_id AND lower(p.primary_email) = lower(inv.email);
  IF v_person IS NOT NULL AND v_status <> 'active' THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;
  IF v_person IS NOT NULL THEN
    SELECT wm.role INTO v_ws_role FROM app.workspace_members wm
    WHERE wm.workspace_id = inv.workspace_id AND wm.person_id = v_person;
  END IF;
  -- Raising a role (new admin, guest -> member/admin, member -> admin) is an admin's decision.
  IF NOT v_inviter_adm AND (
       (inv.role = 'admin' AND coalesce(v_ws_role, '') NOT IN ('owner', 'admin'))
    OR (inv.role = 'member' AND v_ws_role = 'guest')
  ) THEN
    RETURN jsonb_build_object('outcome', 'needs_admin');
  END IF;

  IF v_person IS NULL THEN
    INSERT INTO app.people (workspace_id, display_name, primary_email)
    VALUES (inv.workspace_id, coalesce(nullif(btrim(p_name), ''), split_part(inv.email, '@', 1)), inv.email)
    RETURNING id INTO v_person;
    v_created := true;
  END IF;

  SELECT a.id INTO v_actor FROM app.actors a
  WHERE a.workspace_id = inv.workspace_id AND a.kind = 'person' AND a.ref_id = v_person;
  IF v_actor IS NULL THEN
    INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', inv.workspace_id, v_person) RETURNING id INTO v_actor;
  END IF;

  IF v_ws_role IS NULL THEN
    INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES (inv.workspace_id, v_person, inv.role);
    v_ws_role := inv.role;
  ELSIF (v_ws_role = 'guest' AND inv.role IN ('member', 'admin')) OR (v_ws_role = 'member' AND inv.role = 'admin') THEN
    UPDATE app.workspace_members SET role = inv.role WHERE workspace_id = inv.workspace_id AND person_id = v_person;
    v_ws_role := inv.role;
  END IF;

  IF inv.team_id IS NOT NULL THEN
    v_team_role := CASE WHEN inv.grant_spec ->> 'teamRole' = 'lead' THEN 'lead' ELSE 'member' END;
    INSERT INTO app.team_members (team_id, actor_id, workspace_id, role)
    VALUES (inv.team_id, v_actor, inv.workspace_id, v_team_role)
    ON CONFLICT (team_id, actor_id) DO NOTHING;
    SELECT tm.role INTO v_team_role FROM app.team_members tm WHERE tm.team_id = inv.team_id AND tm.actor_id = v_actor;
  END IF;

  UPDATE app.invitations SET accepted_at = now() WHERE id = inv.id;

  -- A guest invitation's channel grants (P3-16): applied now, as ACL entries for the new guest. Only an invitation whose inviter is
  -- still a workspace owner or admin carries that authority, only for a channel of the named team of this workspace, and a channel
  -- that does not exist (yet) is skipped, never an error. 'read' always; 'post' only when the grant says so.
  IF inv.role = 'guest' AND v_inviter_adm AND jsonb_typeof(inv.grant_spec -> 'channels') = 'array'
     AND to_regclass('app.channels') IS NOT NULL THEN
    FOR g IN SELECT e.value FROM jsonb_array_elements(inv.grant_spec -> 'channels') e LOOP
      CONTINUE WHEN jsonb_typeof(g) <> 'object' OR coalesce(g ->> 'teamId', '') !~ '^[0-9a-f-]{36}$';
      v_chan := NULL;
      EXECUTE 'SELECT c.id FROM app.channels c WHERE c.workspace_id = $1 AND c.team_id = $2::uuid AND c.kind = ''channel'' AND c.name = $3'
        INTO v_chan USING inv.workspace_id, g ->> 'teamId', regexp_replace(coalesce(g ->> 'channel', ''), '^#', '');
      CONTINUE WHEN v_chan IS NULL;
      INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
      VALUES (inv.workspace_id, 'channel', v_chan, 'person', v_person, 'read') ON CONFLICT DO NOTHING;
      IF g ->> 'permission' = 'post' THEN
        INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
        VALUES (inv.workspace_id, 'channel', v_chan, 'person', v_person, 'post') ON CONFLICT DO NOTHING;
      END IF;
      v_grants := v_grants + 1;
    END LOOP;
  END IF;

  INSERT INTO app.events (id, workspace_id, team_id, actor_id, type, schema_version, payload)
  VALUES (v_event, inv.workspace_id, inv.team_id, v_actor, 'workspace.invitation.accepted', 1,
          jsonb_build_object('teamId', inv.team_id, 'invitationId', inv.id, 'personId', v_person, 'role', inv.role,
                             'teamRole', v_team_role, 'createdPerson', v_created));
  -- app.enqueue_outbox only fans out events the current actor wrote: act as the new person for that one call.
  v_prev := current_setting('app.actor_id', true);
  PERFORM set_config('app.actor_id', v_actor::text, true);
  PERFORM app.enqueue_outbox(v_event);
  PERFORM set_config('app.actor_id', coalesce(v_prev, ''), true);

  RETURN jsonb_build_object(
    'outcome', 'ok',
    'workspaceId', inv.workspace_id,
    'personId', v_person,
    'email', inv.email,
    'workspaceRole', v_ws_role,
    'teamId', inv.team_id,
    'teamRole', v_team_role,
    'createdPerson', v_created,
    'channelGrants', v_grants
  );
END
$$;
