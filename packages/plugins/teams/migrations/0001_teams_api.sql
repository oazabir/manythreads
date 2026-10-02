-- teams plugin 0001: what the teams API needs beyond the kernel's 0004-0007 tables. Forward-only: never edit once applied.
--
--  * team_role_tags: which role tags a team defines (the mirror of TEAM.md `roleTags`). roles / role_members stay
--    workspace-wide (an ACL entry can name a role); this table says which team a tag belongs to, so a roster shows its
--    own team's tags and leaving a team drops that team's tags.
--  * app.teams_* functions (SECURITY DEFINER, owned by manythreads_system, same scheme as 0004-0006): the few things a
--    team lead must do that the table policies reserve for admins or hide behind app.actors (which is own-row only):
--    roster listing, adding and removing members, role tags, and accepting an invitation by token. Each one checks the
--    caller itself (app.lookup_can) and answers only about the caller's workspace; none takes a workspace id.

-- team_role_tags (T) -----------------------------------------------------------------------------------------------------
CREATE TABLE app.team_role_tags (
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  role_id      uuid NOT NULL REFERENCES app.roles (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, role_id)
);
CREATE INDEX team_role_tags_role ON app.team_role_tags (role_id);
CREATE INDEX team_role_tags_workspace ON app.team_role_tags (workspace_id);
COMMENT ON TABLE app.team_role_tags IS 'rls: team — T: role tags a team defines (mirrors TEAM.md roleTags); members and workspace admins read, writes only through app.teams_tag_* (system).';

ALTER TABLE app.team_role_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_role_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY team_role_tags_select ON app.team_role_tags FOR SELECT USING (
  app.is_system()
  OR app.is_team_member(team_id)
  OR (workspace_id = app.workspace_id() AND app.is_workspace_admin())
);
CREATE POLICY team_role_tags_system ON app.team_role_tags FOR ALL
  USING (app.is_system()) WITH CHECK (app.is_system());
GRANT SELECT ON app.team_role_tags TO manythreads_app;

-- Helpers -----------------------------------------------------------------------------------------------------------------
-- May the caller change this team's roster, tags and invitations? A lead or workspace admin (app.lookup_can 'manage'); the
-- system pool itself always may (session_user is the LOGIN role, which definer ownership does not change).
CREATE FUNCTION app.teams_can_manage(p_team_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT session_user = 'manythreads_system' OR app.lookup_can('team', p_team_id, 'manage') $$;

-- Roster ---------------------------------------------------------------------------------------------------------------------
-- People on a team with their team role and the team's role tags they hold. Empty unless the caller may read the team.
CREATE FUNCTION app.teams_roster(p_team_id uuid)
  RETURNS TABLE (actor_id uuid, person_id uuid, display_name text, email text, workspace_role text, team_role text,
                 tags text[], joined_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF session_user <> 'manythreads_system' AND NOT app.lookup_can('team', p_team_id, 'read') THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT tm.actor_id, p.id, p.display_name, p.primary_email, wm.role, tm.role,
         coalesce((
           SELECT array_agg(r.name ORDER BY r.name)
           FROM app.role_members rm
           JOIN app.team_role_tags trt ON trt.role_id = rm.role_id AND trt.team_id = tm.team_id
           JOIN app.roles r ON r.id = rm.role_id
           WHERE rm.person_id = p.id
         ), '{}'::text[]),
         tm.created_at
  FROM app.team_members tm
  JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
  JOIN app.people p ON p.id = a.ref_id
  JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id
  WHERE tm.team_id = p_team_id
  ORDER BY (tm.role = 'lead') DESC, lower(p.display_name), p.id;
END
$$;

CREATE FUNCTION app.teams_add_member(p_team_id uuid, p_person_id uuid, p_role text)
  RETURNS TABLE (actor_id uuid, added boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws    uuid;
  v_actor uuid;
  n       integer;
BEGIN
  IF NOT app.teams_can_manage(p_team_id) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may change the roster' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role NOT IN ('lead', 'member') THEN
    RAISE EXCEPTION 'team role must be lead or member' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.workspace_id INTO v_ws FROM app.teams t WHERE t.id = p_team_id;
  SELECT a.id INTO v_actor FROM app.actors a WHERE a.kind = 'person' AND a.ref_id = p_person_id AND a.workspace_id = v_ws;
  IF v_ws IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'person not found in this workspace' USING ERRCODE = 'no_data_found';
  END IF;
  -- team_members_guard (0006) refuses a guest, a non-member of the workspace and anything cross-workspace.
  INSERT INTO app.team_members (team_id, actor_id, workspace_id, role)
  VALUES (p_team_id, v_actor, v_ws, p_role)
  ON CONFLICT (team_id, actor_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN QUERY SELECT v_actor, n > 0;
END
$$;

CREATE FUNCTION app.teams_set_member_role(p_team_id uuid, p_person_id uuid, p_role text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_prev  text;
BEGIN
  IF NOT app.teams_can_manage(p_team_id) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may change a team role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role NOT IN ('lead', 'member') THEN
    RAISE EXCEPTION 'team role must be lead or member' USING ERRCODE = 'check_violation';
  END IF;
  SELECT tm.actor_id, tm.role INTO v_actor, v_prev
  FROM app.team_members tm
  JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' AND a.ref_id = p_person_id
  WHERE tm.team_id = p_team_id
  FOR UPDATE OF tm;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not a member of this team' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_prev <> p_role THEN
    UPDATE app.team_members SET role = p_role WHERE team_id = p_team_id AND actor_id = v_actor;
  END IF;
  RETURN v_prev;
END
$$;

-- Role tags a person holds because of one team: the team's tags, unless another team of theirs defines the same tag.
CREATE FUNCTION app.teams_person_team_tags(p_team_id uuid, p_person_id uuid) RETURNS TABLE (role_id uuid, name text)
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT r.id, r.name
  FROM app.team_role_tags trt
  JOIN app.role_members rm ON rm.role_id = trt.role_id AND rm.person_id = p_person_id
  JOIN app.roles r ON r.id = trt.role_id
  WHERE trt.team_id = p_team_id
    AND NOT EXISTS (
      SELECT 1
      FROM app.team_role_tags other
      JOIN app.team_members tm ON tm.team_id = other.team_id
      JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' AND a.ref_id = p_person_id
      WHERE other.role_id = trt.role_id AND other.team_id <> p_team_id
    )
$$;

-- Removes a person from a team (a lead or admin, or the person themself) together with the tags that team gave them.
CREATE FUNCTION app.teams_remove_member(p_team_id uuid, p_person_id uuid)
  RETURNS TABLE (removed boolean, team_role text, tags text[])
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_actor uuid;
  v_role  text;
  v_tags  text[];
BEGIN
  IF NOT (app.teams_can_manage(p_team_id) OR coalesce(p_person_id = app.person_id(), false)) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may remove a member' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT tm.actor_id, tm.role INTO v_actor, v_role
  FROM app.team_members tm
  JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' AND a.ref_id = p_person_id
  WHERE tm.team_id = p_team_id
  FOR UPDATE OF tm;
  IF v_actor IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, '{}'::text[];
    RETURN;
  END IF;
  SELECT coalesce(array_agg(t.name ORDER BY t.name), '{}'::text[]) INTO v_tags
  FROM app.teams_person_team_tags(p_team_id, p_person_id) t;
  DELETE FROM app.role_members rm
  WHERE rm.person_id = p_person_id
    AND rm.role_id IN (SELECT t.role_id FROM app.teams_person_team_tags(p_team_id, p_person_id) t);
  DELETE FROM app.team_members WHERE team_id = p_team_id AND actor_id = v_actor;
  RETURN QUERY SELECT true, v_role, v_tags;
END
$$;

-- Role tags ----------------------------------------------------------------------------------------------------------------------
-- Defines a tag for the team: the workspace role row (get-or-create) and the team's link to it.
CREATE FUNCTION app.teams_tag_define(p_team_id uuid, p_tag text) RETURNS TABLE (role_id uuid, created boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws   uuid;
  v_role uuid;
  n      integer;
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
  INSERT INTO app.roles (workspace_id, name) VALUES (v_ws, p_tag)
  ON CONFLICT (workspace_id, name) DO SELECT RETURNING id INTO v_role;
  INSERT INTO app.team_role_tags (team_id, role_id, workspace_id) VALUES (p_team_id, v_role, v_ws)
  ON CONFLICT (team_id, role_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN QUERY SELECT v_role, n > 0;
END
$$;

-- Drops the team's tag: everyone on the team loses it, and the workspace role goes when no other team defines it.
CREATE FUNCTION app.teams_tag_drop(p_team_id uuid, p_tag text) RETURNS TABLE (deleted boolean, removed_from uuid[])
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_role    uuid;
  v_holders uuid[];
BEGIN
  IF NOT app.teams_can_manage(p_team_id) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may delete a role tag' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT trt.role_id INTO v_role
  FROM app.team_role_tags trt JOIN app.roles r ON r.id = trt.role_id
  WHERE trt.team_id = p_team_id AND r.name = p_tag;
  IF v_role IS NULL THEN
    RETURN QUERY SELECT false, '{}'::uuid[];
    RETURN;
  END IF;
  -- Holders are the team's members who hold the tag (a person who also sits in another team defining it keeps it).
  SELECT coalesce(array_agg(DISTINCT a.ref_id), '{}'::uuid[]) INTO v_holders
  FROM app.team_members tm
  JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
  JOIN app.role_members rm ON rm.person_id = a.ref_id AND rm.role_id = v_role
  WHERE tm.team_id = p_team_id;
  DELETE FROM app.role_members rm
  WHERE rm.role_id = v_role
    AND rm.person_id = ANY (v_holders)
    AND NOT EXISTS (
      SELECT 1
      FROM app.team_role_tags other
      JOIN app.team_members tm ON tm.team_id = other.team_id
      JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' AND a.ref_id = rm.person_id
      WHERE other.role_id = v_role AND other.team_id <> p_team_id
    );
  DELETE FROM app.team_role_tags WHERE team_id = p_team_id AND role_id = v_role;
  IF NOT EXISTS (SELECT 1 FROM app.team_role_tags WHERE role_id = v_role) THEN
    DELETE FROM app.roles WHERE id = v_role;
  END IF;
  RETURN QUERY SELECT true, v_holders;
END
$$;

-- A role tag is a workspace-level fact about a person (an ACL entry may name the role); a team lists the tags it defines.
-- `assigned` is therefore "the roster of this team did not show this tag for this person yet": a person who already
-- holds role:on-call from another team gets it on this roster too, and that counts as an assignment.
CREATE FUNCTION app.teams_tag_assign(p_team_id uuid, p_person_id uuid, p_tag text)
  RETURNS TABLE (role_id uuid, defined boolean, assigned boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws      uuid;
  v_role    uuid;
  v_defined boolean;
  v_shown   boolean;
BEGIN
  IF NOT app.teams_can_manage(p_team_id) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may assign a role tag' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.team_members tm
    JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' AND a.ref_id = p_person_id
    WHERE tm.team_id = p_team_id
  ) THEN
    RAISE EXCEPTION 'not a member of this team' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM app.team_role_tags trt
    JOIN app.roles r ON r.id = trt.role_id
    JOIN app.role_members rm ON rm.role_id = r.id AND rm.person_id = p_person_id
    WHERE trt.team_id = p_team_id AND r.name = p_tag
  ) INTO v_shown;
  SELECT d.role_id, d.created INTO v_role, v_defined FROM app.teams_tag_define(p_team_id, p_tag) d;
  SELECT t.workspace_id INTO v_ws FROM app.teams t WHERE t.id = p_team_id;
  INSERT INTO app.role_members (role_id, person_id, workspace_id) VALUES (v_role, p_person_id, v_ws)
  ON CONFLICT (role_id, person_id) DO NOTHING;
  RETURN QUERY SELECT v_role, v_defined, NOT v_shown;
END
$$;

CREATE FUNCTION app.teams_tag_unassign(p_team_id uuid, p_person_id uuid, p_tag text) RETURNS boolean
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
  USING app.roles r
  WHERE rm.role_id = r.id AND r.name = p_tag AND r.workspace_id = app.workspace_id() AND rm.person_id = p_person_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;

-- Invitations by token ---------------------------------------------------------------------------------------------------------
-- The token is the credential, so both functions are open to the anonymous app role; they take the sha256 of the token.
-- `outcome`: ok | not_found | gone (used or expired) | forbidden (the person is suspended).
CREATE FUNCTION app.teams_invitation_info(p_token_hash bytea) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  inv app.invitations;
BEGIN
  SELECT i.* INTO inv FROM app.invitations i
  WHERE i.token_hash = p_token_hash
  ORDER BY (i.accepted_at IS NULL) DESC, i.created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF inv.accepted_at IS NOT NULL OR inv.expires_at <= now() THEN
    RETURN jsonb_build_object('outcome', 'gone');
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'ok',
    'workspaceName', (SELECT w.name FROM app.workspaces w WHERE w.id = inv.workspace_id),
    'teamName', (SELECT t.name FROM app.teams t WHERE t.id = inv.team_id),
    'email', inv.email,
    'role', inv.role,
    'invitedBy', (SELECT p.display_name FROM app.people p WHERE p.id = inv.invited_by),
    'expiresAt', inv.expires_at
  );
END
$$;

-- Accepts once: finds or creates the person (and their actor), grants the workspace role (never lowering an existing one;
-- a guest who is invited as a member is promoted), seats them on the team, marks the invitation used and records
-- workspace.invitation.accepted as the new person. The event is written here because the caller has no actor yet.
CREATE FUNCTION app.teams_invitation_accept(p_token_hash bytea, p_name text) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  inv         app.invitations;
  v_person    uuid;
  v_status    text;
  v_actor     uuid;
  v_created   boolean := false;
  v_ws_role   text;
  v_team_role text;
  v_event     uuid := uuidv7();
  v_prev      text;
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

  SELECT p.id, p.status INTO v_person, v_status
  FROM app.people p WHERE p.workspace_id = inv.workspace_id AND lower(p.primary_email) = lower(inv.email);
  IF v_person IS NULL THEN
    INSERT INTO app.people (workspace_id, display_name, primary_email)
    VALUES (inv.workspace_id, coalesce(nullif(btrim(p_name), ''), split_part(inv.email, '@', 1)), inv.email)
    RETURNING id INTO v_person;
    v_created := true;
  ELSIF v_status <> 'active' THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;

  SELECT a.id INTO v_actor FROM app.actors a
  WHERE a.workspace_id = inv.workspace_id AND a.kind = 'person' AND a.ref_id = v_person;
  IF v_actor IS NULL THEN
    INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', inv.workspace_id, v_person) RETURNING id INTO v_actor;
  END IF;

  SELECT wm.role INTO v_ws_role FROM app.workspace_members wm
  WHERE wm.workspace_id = inv.workspace_id AND wm.person_id = v_person;
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

-- Privileges and ownership -----------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  app.teams_can_manage(uuid), app.teams_roster(uuid), app.teams_add_member(uuid, uuid, text),
  app.teams_set_member_role(uuid, uuid, text), app.teams_person_team_tags(uuid, uuid), app.teams_remove_member(uuid, uuid),
  app.teams_tag_define(uuid, text), app.teams_tag_drop(uuid, text), app.teams_tag_assign(uuid, uuid, text),
  app.teams_tag_unassign(uuid, uuid, text), app.teams_invitation_info(bytea), app.teams_invitation_accept(bytea, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.teams_can_manage(uuid), app.teams_roster(uuid), app.teams_add_member(uuid, uuid, text),
  app.teams_set_member_role(uuid, uuid, text), app.teams_person_team_tags(uuid, uuid), app.teams_remove_member(uuid, uuid),
  app.teams_tag_define(uuid, text), app.teams_tag_drop(uuid, text), app.teams_tag_assign(uuid, uuid, text),
  app.teams_tag_unassign(uuid, uuid, text), app.teams_invitation_info(bytea), app.teams_invitation_accept(bytea, text)
  TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.teams_roster(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.teams_add_member(uuid, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.teams_set_member_role(uuid, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.teams_remove_member(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.teams_tag_define(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.teams_tag_drop(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.teams_tag_assign(uuid, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.teams_tag_unassign(uuid, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.teams_invitation_info(bytea) OWNER TO manythreads_system;
ALTER FUNCTION app.teams_invitation_accept(bytea, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
