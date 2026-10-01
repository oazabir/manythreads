-- teams plugin 0002: review fixes for 0001. Forward-only: never edit once applied. CREATE OR REPLACE keeps each function's
-- owner (manythreads_system) and grants.
--
--  1. teams_tag_define: a role tag is a workspace role that ACL entries may name. A team lead could "define" a role that
--     already exists (an admin-made role, or another team's tag such as role:on-call) and then give it to themself,
--     inheriting whatever ACL entries name it. Only a workspace admin may attach an existing role the team does not
--     already own; a lead still creates new tags and keeps the ones the team defines.
--  2. teams_tag_unassign: removed any role of that name from a team member, including roles the team does not define
--     (another team's tag, an admin-granted role). It now touches only the tags this team defines.
--  3. teams_invitation_accept: the person accepting is anonymous, so the invitation carries the inviter's authority. A
--     team lead's invitation (role member) could be accepted by the lead with the invitee's email to promote an existing
--     guest to member, or an admin invitation outlive its admin. Raising a workspace role now needs an inviter who is an
--     active owner/admin at accept time ('needs_admin'); a team invitation also needs its inviter to still be a lead of
--     that team or an admin (otherwise 'gone', like an expired one). Nothing is written when the answer is not 'ok'.

CREATE OR REPLACE FUNCTION app.teams_tag_define(p_team_id uuid, p_tag text) RETURNS TABLE (role_id uuid, created boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws       uuid;
  v_role     uuid;
  v_existing uuid;
  n          integer;
BEGIN
  IF NOT app.teams_can_manage(p_team_id) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may define a role tag' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_tag !~ '^role:[a-z][a-z0-9-]*$' THEN
    RAISE EXCEPTION 'role tag must look like role:on-call' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.workspace_id INTO v_ws FROM app.teams t WHERE t.id = p_team_id;
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'team not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT r.id INTO v_existing FROM app.roles r WHERE r.workspace_id = v_ws AND r.name = p_tag;
  IF v_existing IS NOT NULL
     AND session_user <> 'manythreads_system'
     AND coalesce(app.lookup_workspace_role(), '') NOT IN ('owner', 'admin')
     AND NOT EXISTS (SELECT 1 FROM app.team_role_tags trt WHERE trt.team_id = p_team_id AND trt.role_id = v_existing)
  THEN
    RAISE EXCEPTION 'that role tag already exists in the workspace; ask a workspace admin to add it to this team'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.roles (workspace_id, name) VALUES (v_ws, p_tag)
  ON CONFLICT (workspace_id, name) DO SELECT RETURNING id INTO v_role;
  INSERT INTO app.team_role_tags (team_id, role_id, workspace_id) VALUES (p_team_id, v_role, v_ws)
  ON CONFLICT (team_id, role_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN QUERY SELECT v_role, n > 0;
END
$$;

CREATE OR REPLACE FUNCTION app.teams_tag_unassign(p_team_id uuid, p_person_id uuid, p_tag text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF NOT app.teams_can_manage(p_team_id) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may remove a role tag' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.team_members tm
    JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' AND a.ref_id = p_person_id
    WHERE tm.team_id = p_team_id
  ) THEN
    RAISE EXCEPTION 'not a member of this team' USING ERRCODE = 'no_data_found';
  END IF;
  DELETE FROM app.role_members rm
  USING app.roles r, app.team_role_tags trt
  WHERE rm.role_id = r.id AND r.name = p_tag AND r.workspace_id = app.workspace_id() AND rm.person_id = p_person_id
    AND trt.role_id = r.id AND trt.team_id = p_team_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;

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
    'createdPerson', v_created
  );
END
$$;
