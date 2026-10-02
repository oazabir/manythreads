-- 0006_teams_acl: PLAN.md A.2 teams, team_members, roles, role_members, acl_entries, team_pending_files, plus the real
-- app.is_team_member / app.team_role / app.can helpers. Forward-only: never edit this file once applied.
--
-- RECURSION. Same scheme as 0004: the public helpers are invoker functions `app.is_system() OR <lookup>`; each lookup
-- is a SECURITY DEFINER function owned by manythreads_system that answers only about the caller (app.actor()). Inside it
-- current_user = manythreads_system, so the policies of team_members / roles / acl_entries pass on `app.is_system()`, their
-- first operand, and never call a helper again. tests: kernel/test/rls/teams.test.ts ("no policy recursion").
--
-- app.can(resource_type, resource_id, permission). Permissions are ordered read < post < manage. A resource type is
-- registered in app.resource_kinds (table, team column) so the function can find the owning team without knowing
-- every table; unknown types and unknown ids deny. Allowed when ANY of:
--   * workspace owner/admin of the resource's workspace                       (manage, so everything)
--   * team member of the resource's team: read+post; team lead: manage         (a guest is never a team member)
--   * an acl_entries grant, to the caller's person, to a team they belong to, or to a role tag they hold,
--     of at least the requested permission.
-- A suspended person, a bot of another workspace, a missing actor row or a resource of another workspace deny.

-- resource_kinds (G) ---------------------------------------------------------------------------------------------------
CREATE TABLE app.resource_kinds (
  resource_type text PRIMARY KEY CHECK (resource_type ~ '^[a-z][a-z0-9_]*$'),
  table_name    text NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]*$'),
  team_column   text CHECK (team_column IS NULL OR team_column ~ '^[a-z][a-z0-9_]*$'),
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.resource_kinds IS 'rls: global — registry of resource types for app.can(); written by migrations only (manythreads_app has no grant).';
INSERT INTO app.global_tables (name) VALUES ('resource_kinds');

-- teams (T; admin all) -------------------------------------------------------------------------------------------------
CREATE TABLE app.teams (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  slug                text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name                text NOT NULL CHECK (name <> ''),
  template            text,
  template_definition jsonb,
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
COMMENT ON TABLE app.teams IS 'rls: team — T: members see their teams, workspace admins see and manage all, leads rename and archive.';

INSERT INTO app.resource_kinds (resource_type, table_name, team_column) VALUES ('team', 'teams', 'id');

-- team_members (T) -------------------------------------------------------------------------------------------------------
CREATE TABLE app.team_members (
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  actor_id     uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, actor_id)
);
CREATE INDEX team_members_actor ON app.team_members (actor_id);
CREATE INDEX team_members_workspace ON app.team_members (workspace_id);
COMMENT ON TABLE app.team_members IS 'rls: team — T: roster of people and bots; members and workspace admins read, leads and admins write; never a guest.';

ALTER TABLE app.invitations
  ADD CONSTRAINT invitations_team_fk FOREIGN KEY (team_id) REFERENCES app.teams (id) ON DELETE CASCADE;

-- roles, role_members (WR) --------------------------------------------------------------------------------------------------
CREATE TABLE app.roles (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (name ~ '^role:[a-z][a-z0-9-]*$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
COMMENT ON TABLE app.roles IS 'rls: workspace — WR: role tags (role:on-call) mirrored from TEAM.md; members read, admins write.';

CREATE TABLE app.role_members (
  role_id      uuid NOT NULL REFERENCES app.roles (id) ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, person_id)
);
CREATE INDEX role_members_person ON app.role_members (person_id);
CREATE INDEX role_members_workspace ON app.role_members (workspace_id);
COMMENT ON TABLE app.role_members IS 'rls: workspace — WR: who holds a role tag; members read, admins write.';

-- acl_entries (W; subject reads own) ----------------------------------------------------------------------------------------
CREATE TABLE app.acl_entries (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]*$'),
  resource_id   uuid NOT NULL,
  subject_type  text NOT NULL CHECK (subject_type IN ('person', 'team', 'role')),
  subject_id    uuid NOT NULL,
  permission    text NOT NULL CHECK (permission IN ('read', 'post', 'manage')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id, subject_type, subject_id, permission)
);
CREATE INDEX acl_entries_subject ON app.acl_entries (subject_type, subject_id);
CREATE INDEX acl_entries_workspace ON app.acl_entries (workspace_id);
COMMENT ON TABLE app.acl_entries IS 'rls: workspace — W: admins write; a subject (person, team member, role holder) reads its own grants.';

-- team_pending_files (S) ----------------------------------------------------------------------------------------------------
CREATE TABLE app.team_pending_files (
  team_id    uuid PRIMARY KEY REFERENCES app.teams (id) ON DELETE CASCADE,
  files      jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.team_pending_files IS 'rls: system — S: TEAM.md awaiting the repo; leads and admins write through app.put_team_pending_files.';

-- Lookups (SECURITY DEFINER, owned by manythreads_system) --------------------------------------------------------------------------
-- The caller's role in a team; NULL when not a member. A person counts only while active and a non-guest workspace member,
-- so suspending or demoting someone to guest cuts team access immediately, even if a roster row survives.
CREATE FUNCTION app.lookup_team_role(p_team_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT tm.role
  FROM app.team_members tm
  JOIN app.actors a ON a.id = tm.actor_id AND a.workspace_id = tm.workspace_id
  WHERE tm.team_id = p_team_id
    AND tm.actor_id = app.actor()
    AND a.workspace_id = app.workspace_id()
    AND (
      a.kind <> 'person'
      OR EXISTS (
        SELECT 1
        FROM app.people p
        JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id
        WHERE p.id = a.ref_id AND p.status = 'active' AND wm.role <> 'guest'
      )
    )
$$;

-- Does the caller hold the role tag?
CREATE FUNCTION app.lookup_has_role(p_role_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.role_members rm
    JOIN app.actors a ON a.ref_id = rm.person_id AND a.kind = 'person' AND a.workspace_id = rm.workspace_id
    WHERE rm.role_id = p_role_id AND a.id = app.actor() AND a.workspace_id = app.workspace_id()
  ) AND app.lookup_workspace_role() IS NOT NULL
$$;

CREATE FUNCTION app.permission_rank(p_permission text) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
  AS $$ SELECT CASE p_permission WHEN 'read' THEN 1 WHEN 'post' THEN 2 WHEN 'manage' THEN 3 END $$;

-- Team-level check without reading any resource row: what a table policy needs for the row being written (a policy cannot
-- look up its own new row by id, so INSERT policies and `RETURNING` checks use the row's team_id with this).
CREATE FUNCTION app.lookup_can_team(p_team_id uuid, p_permission text) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws      uuid := app.workspace_id();
  v_actor   uuid := app.actor();
  v_need    integer := app.permission_rank(p_permission);
  v_kind    text;
  v_ws_role text;
  v_role    text;
BEGIN
  IF v_need IS NULL OR v_ws IS NULL OR v_actor IS NULL OR p_team_id IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.teams t WHERE t.id = p_team_id AND t.workspace_id = v_ws) THEN
    RETURN false;
  END IF;
  SELECT a.kind INTO v_kind FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
  IF v_kind IS NULL OR v_kind = 'system' THEN
    RETURN false;
  END IF;
  IF v_kind = 'person' THEN
    v_ws_role := app.lookup_workspace_role();
    IF v_ws_role IS NULL OR v_ws_role = 'guest' THEN
      RETURN false;
    ELSIF v_ws_role IN ('owner', 'admin') THEN
      RETURN true;
    END IF;
  END IF;
  v_role := app.lookup_team_role(p_team_id);
  RETURN v_role = 'lead' OR (v_role = 'member' AND v_need <= 2);
END
$$;

CREATE FUNCTION app.lookup_can(p_resource_type text, p_resource_id uuid, p_permission text) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws        uuid := app.workspace_id();
  v_actor     uuid := app.actor();
  v_need      integer := app.permission_rank(p_permission);
  v_kind      text;
  v_ref       uuid;
  v_table     text;
  v_team_col  text;
  v_team      uuid;
  v_res_ws    uuid;
  v_ws_role   text;
BEGIN
  IF v_need IS NULL OR v_ws IS NULL OR v_actor IS NULL OR p_resource_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT a.kind, a.ref_id INTO v_kind, v_ref FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
  IF v_kind IS NULL OR v_kind = 'system' THEN
    RETURN false;
  END IF;

  SELECT k.table_name, k.team_column INTO v_table, v_team_col
  FROM app.resource_kinds k WHERE k.resource_type = p_resource_type;
  IF v_table IS NULL THEN
    RETURN false;
  END IF;
  -- Identifiers come from resource_kinds (written by migrations, shape-checked); %I quotes them anyway.
  EXECUTE format('SELECT %s, workspace_id FROM app.%I WHERE id = $1',
                 CASE WHEN v_team_col IS NULL THEN 'NULL::uuid' ELSE format('%I', v_team_col) END, v_table)
    INTO v_team, v_res_ws USING p_resource_id;
  IF v_res_ws IS DISTINCT FROM v_ws THEN
    RETURN false;
  END IF;

  IF v_kind = 'person' THEN
    v_ws_role := app.lookup_workspace_role();   -- NULL: suspended, no membership
    IF v_ws_role IS NULL THEN
      RETURN false;
    END IF;
    IF v_ws_role IN ('owner', 'admin') THEN
      RETURN true;
    END IF;
  END IF;

  IF v_team IS NOT NULL AND coalesce(v_ws_role, '') <> 'guest' AND app.lookup_can_team(v_team, p_permission) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM app.acl_entries e
    WHERE e.workspace_id = v_ws
      AND e.resource_type = p_resource_type
      AND e.resource_id = p_resource_id
      AND app.permission_rank(e.permission) >= v_need
      AND (
        (e.subject_type = 'person' AND v_kind = 'person' AND e.subject_id = v_ref)
        OR (e.subject_type = 'team' AND app.lookup_team_role(e.subject_id) IS NOT NULL)
        OR (e.subject_type = 'role' AND v_kind = 'person' AND app.lookup_has_role(e.subject_id))
      )
  );
END
$$;

-- Public helpers: replace the 0003 placeholders (same signatures, still invoker) ----------------------------------------------
CREATE OR REPLACE FUNCTION app.is_team_member(team_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT app.is_system() OR app.lookup_team_role(team_id) IS NOT NULL $$;

CREATE OR REPLACE FUNCTION app.team_role(team_id uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT CASE WHEN app.is_system() THEN 'system' ELSE app.lookup_team_role(team_id) END $$;

CREATE OR REPLACE FUNCTION app.can(resource_type text, resource_id uuid, permission text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT app.is_system() OR app.lookup_can(resource_type, resource_id, permission) $$;

CREATE FUNCTION app.can_in_team(team_id uuid, permission text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT app.is_system() OR app.lookup_can_team(team_id, permission) $$;

CREATE FUNCTION app.has_role(role_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT app.is_system() OR app.lookup_has_role(role_id) $$;

-- The one door to team_pending_files for a lead or admin (the table itself is system only). Only an unapplied row is replaced.
CREATE FUNCTION app.put_team_pending_files(p_team_id uuid, p_files jsonb) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF session_user <> 'manythreads_system' AND NOT app.lookup_can('team', p_team_id, 'manage') THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may hold team files' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.team_pending_files (team_id, files) VALUES (p_team_id, coalesce(p_files, '{}'::jsonb))
  ON CONFLICT (team_id) DO UPDATE SET files = EXCLUDED.files WHERE app.team_pending_files.applied_at IS NULL;
END
$$;

-- Guards (definer: they read tables the writer may not see) -------------------------------------------------------------------
-- A team member is a bot, or an active-or-not person who is a non-guest member of the team's workspace.
CREATE FUNCTION app.team_members_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_team_ws  uuid;
  v_kind     text;
  v_ref      uuid;
  v_actor_ws uuid;
  v_role     text;
BEGIN
  SELECT t.workspace_id INTO v_team_ws FROM app.teams t WHERE t.id = NEW.team_id;
  IF v_team_ws IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'team_members.workspace_id must equal the team''s workspace' USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.kind, a.ref_id, a.workspace_id INTO v_kind, v_ref, v_actor_ws FROM app.actors a WHERE a.id = NEW.actor_id;
  IF v_kind IS NULL OR v_actor_ws <> NEW.workspace_id THEN
    RAISE EXCEPTION 'team member must be an actor of the team''s workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF v_kind = 'system' THEN
    RAISE EXCEPTION 'the system actor cannot be a team member' USING ERRCODE = 'check_violation';
  END IF;
  IF v_kind = 'person' THEN
    SELECT wm.role INTO v_role FROM app.workspace_members wm
    WHERE wm.workspace_id = NEW.workspace_id AND wm.person_id = v_ref;
    IF v_role IS NULL THEN
      RAISE EXCEPTION 'a person must be a workspace member to join a team' USING ERRCODE = 'check_violation';
    ELSIF v_role = 'guest' THEN
      RAISE EXCEPTION 'a workspace guest cannot be a team member' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER team_members_guard BEFORE INSERT OR UPDATE OF team_id, actor_id, workspace_id ON app.team_members
  FOR EACH ROW EXECUTE FUNCTION app.team_members_guard();

-- ...and the reverse: nobody who sits in a team becomes a guest.
CREATE FUNCTION app.workspace_members_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.role = 'guest' AND EXISTS (
    SELECT 1 FROM app.team_members tm
    JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
    WHERE a.ref_id = NEW.person_id AND tm.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'a team member cannot become a workspace guest; remove them from their teams first'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workspace_members_guard BEFORE INSERT OR UPDATE OF role ON app.workspace_members
  FOR EACH ROW EXECUTE FUNCTION app.workspace_members_guard();

-- Row level security --------------------------------------------------------------------------------------------------------------
ALTER TABLE app.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.teams FORCE ROW LEVEL SECURITY;
CREATE POLICY teams_select ON app.teams FOR SELECT USING (
  app.is_system() OR app.is_team_member(id) OR (workspace_id = app.workspace_id() AND app.is_workspace_admin())
);
CREATE POLICY teams_insert ON app.teams FOR INSERT
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));
CREATE POLICY teams_update ON app.teams FOR UPDATE
  USING (
    app.is_system()
    OR (workspace_id = app.workspace_id() AND (app.is_workspace_admin() OR app.team_role(id) = 'lead'))
  )
  WITH CHECK (
    app.is_system()
    OR (workspace_id = app.workspace_id() AND (app.is_workspace_admin() OR app.team_role(id) = 'lead'))
  );
CREATE POLICY teams_delete ON app.teams FOR DELETE
  USING (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));

ALTER TABLE app.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_members FORCE ROW LEVEL SECURITY;
CREATE POLICY team_members_select ON app.team_members FOR SELECT USING (
  app.is_system() OR app.is_team_member(team_id) OR (workspace_id = app.workspace_id() AND app.is_workspace_admin())
);
CREATE POLICY team_members_insert ON app.team_members FOR INSERT WITH CHECK (
  app.is_system()
  OR (workspace_id = app.workspace_id() AND (app.is_workspace_admin() OR app.team_role(team_id) = 'lead'))
);
CREATE POLICY team_members_update ON app.team_members FOR UPDATE
  USING (
    app.is_system()
    OR (workspace_id = app.workspace_id() AND (app.is_workspace_admin() OR app.team_role(team_id) = 'lead'))
  )
  WITH CHECK (
    app.is_system()
    OR (workspace_id = app.workspace_id() AND (app.is_workspace_admin() OR app.team_role(team_id) = 'lead'))
  );
CREATE POLICY team_members_delete ON app.team_members FOR DELETE USING (
  app.is_system()
  OR actor_id = app.actor()
  OR (workspace_id = app.workspace_id() AND (app.is_workspace_admin() OR app.team_role(team_id) = 'lead'))
);

ALTER TABLE app.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_select ON app.roles FOR SELECT USING (
  app.is_system() OR (workspace_id = app.workspace_id() AND app.workspace_role() IN ('owner', 'admin', 'member'))
);
CREATE POLICY roles_write ON app.roles FOR ALL
  USING (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()))
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));
-- roles_select and roles_write both apply to SELECT (permissive policies OR together): admins are members anyway.

ALTER TABLE app.role_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.role_members FORCE ROW LEVEL SECURITY;
CREATE POLICY role_members_select ON app.role_members FOR SELECT USING (
  app.is_system() OR (workspace_id = app.workspace_id() AND app.workspace_role() IN ('owner', 'admin', 'member'))
);
CREATE POLICY role_members_write ON app.role_members FOR ALL
  USING (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()))
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));

ALTER TABLE app.acl_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.acl_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY acl_entries_select ON app.acl_entries FOR SELECT USING (
  app.is_system()
  OR (workspace_id = app.workspace_id() AND (
        app.is_workspace_admin()
        OR (subject_type = 'person' AND subject_id = app.person_id())
        OR (subject_type = 'team' AND app.is_team_member(subject_id))
        OR (subject_type = 'role' AND app.has_role(subject_id))
  ))
);
CREATE POLICY acl_entries_insert ON app.acl_entries FOR INSERT
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));
CREATE POLICY acl_entries_update ON app.acl_entries FOR UPDATE
  USING (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()))
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));
CREATE POLICY acl_entries_delete ON app.acl_entries FOR DELETE
  USING (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));

ALTER TABLE app.team_pending_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.team_pending_files FORCE ROW LEVEL SECURITY;
CREATE POLICY team_pending_files_system ON app.team_pending_files FOR ALL
  USING (app.is_system()) WITH CHECK (app.is_system());

-- scoped_kv (0001): workspace scope was "any actor of that workspace" until guests existed. A guest must not read
-- plugin workspace data; non-guest members read, admins write (unchanged).
DROP POLICY scoped_kv_select ON app.scoped_kv;
CREATE POLICY scoped_kv_select ON app.scoped_kv FOR SELECT USING (
  app.is_system()
  OR (scope_type = 'team' AND app.is_team_member(scope_id))
  OR (scope_type = 'person' AND scope_id = app.person_id())
  OR (scope_type = 'workspace' AND scope_id = app.workspace_id()
      AND app.workspace_role() IN ('owner', 'admin', 'member'))
);

-- Privileges ----------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON app.teams, app.team_members, app.roles, app.role_members, app.acl_entries
  TO manythreads_app;
REVOKE ALL ON app.team_pending_files, app.resource_kinds FROM PUBLIC, manythreads_app;
-- resource_kinds is migration-written: nobody but the owner changes it.
REVOKE INSERT, UPDATE, DELETE ON app.resource_kinds FROM manythreads_system;

REVOKE ALL ON FUNCTION app.put_team_pending_files(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.put_team_pending_files(uuid, jsonb) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.lookup_team_role(uuid), app.lookup_has_role(uuid), app.lookup_can(text, uuid, text),
  app.lookup_can_team(uuid, text), app.can_in_team(uuid, text), app.permission_rank(text), app.has_role(uuid) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.lookup_team_role(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.lookup_has_role(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.lookup_can(text, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.lookup_can_team(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.put_team_pending_files(uuid, jsonb) OWNER TO manythreads_system;
ALTER FUNCTION app.team_members_guard() OWNER TO manythreads_system;
ALTER FUNCTION app.workspace_members_guard() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
