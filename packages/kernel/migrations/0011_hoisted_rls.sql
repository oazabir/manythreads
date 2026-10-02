-- 0011_hoisted_rls (P3-00): row policies that ask "may the caller see this team?" once per statement, not once per row.
-- Forward-only: never edit this file once applied.
--
-- PROBLEM (docs/retro/phase-2.md section 9). A policy like `app.can_in_team(team_id, 'read') OR app.can(type, id, 'read')`
-- runs a STABLE plpgsql function for every row the statement touches (70 to 250 microseconds each). On 300,000 rows an
-- unscoped `SELECT count(*)` took 77 s for Nadia, 74 s for Lena (denied everything) and 21 s for Omar.
--
-- FIX. The caller's visibility is a SET that does not depend on the row, so it is computed once and the policy probes it:
--
--     team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
--
-- (Wrap the system test the same way, `(SELECT app.is_system())`: a bare app.is_system() is a function call per row too,
-- about 0.45 s on 300,000 rows, and wrapping it took the three counts from 0.5 s to 0.05 s.)
-- The uncorrelated scalar subquery becomes an InitPlan (evaluated once per statement, lazily); the per-row work is a plain
-- array probe, and `team_id = ANY (InitPlan)` can drive an index scan. The same statements now take about half a second
-- on 300,000 rows (docs/retro/phase-3.md). Every table that grows with usage (messages, tasks, files) must use this idiom
-- for its read policy; the RLS harness (findPerRowPolicyCalls in @manythreads/test-utils) fails a table whose plan still calls
-- app.can / app.can_in_team / app.is_team_member / app.team_role / app.has_role per row.
--
-- The three functions below follow the 0006 scheme: SECURITY DEFINER, owned by manythreads_system (so they can read
-- actors / team_members / acl_entries without RLS filtering), pinned search_path, STABLE. They answer only about the caller
-- (app.actor() / app.workspace_id()) and never take a workspace or actor argument. Inside a definer function owned by
-- manythreads_system the is_* helpers are always TRUE (current_user), so the caller is checked with
-- app.lookup_workspace_role() and the actor row, exactly like lookup_can_team (MISTAKES: P2 review).
--
--   app.member_team_ids(permission)   teams the caller sits in at >= permission (read/post: every member; manage: leads).
--                                     No admin override: for tables whose policy says "members only" (events, entity_links).
--   app.readable_team_ids(permission) member_team_ids plus every team of the workspace for a workspace owner/admin. A guest,
--                                     a suspended person, a system or unknown actor gets the empty array.
--   app.acl_grant_ids(type, permission) ids of resources of `type` the caller holds an acl_entries grant on (person, team
--                                     the caller belongs to, or role tag the caller holds) at >= permission. Grants only:
--                                     it does not add admin or team access (combine with readable_team_ids in the policy).
--   app.held_role_ids()               role tags the caller holds (for the acl_entries policy).
--
-- Per-row visibility that is not team-based (private channels, DMs: a membership row per channel) uses the same idiom with
-- a plugin-owned helper that returns the uuid[] of ids the caller may see; docs/plugins/README.md "Visibility sets".
-- app.can() stays for single-row checks (routes, write policies).

CREATE FUNCTION app.member_team_ids(p_permission text DEFAULT 'read') RETURNS uuid[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws      uuid := app.workspace_id();
  v_actor   uuid := app.actor();
  v_need    integer := app.permission_rank(p_permission);
  v_kind    text;
  v_ws_role text;
BEGIN
  IF v_need IS NULL OR v_ws IS NULL OR v_actor IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  SELECT a.kind INTO v_kind FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
  IF v_kind IS NULL OR v_kind = 'system' THEN
    RETURN '{}'::uuid[];
  END IF;
  IF v_kind = 'person' THEN
    -- active person with a non-guest membership, as in lookup_team_role
    v_ws_role := app.lookup_workspace_role();
    IF v_ws_role IS NULL OR v_ws_role = 'guest' THEN
      RETURN '{}'::uuid[];
    END IF;
  END IF;
  RETURN coalesce((
    SELECT array_agg(tm.team_id)
    FROM app.team_members tm
    JOIN app.teams t ON t.id = tm.team_id AND t.workspace_id = v_ws
    WHERE tm.actor_id = v_actor AND tm.workspace_id = v_ws AND (tm.role = 'lead' OR v_need <= 2)
  ), '{}'::uuid[]);
END
$$;

CREATE FUNCTION app.readable_team_ids(p_permission text DEFAULT 'read') RETURNS uuid[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws      uuid := app.workspace_id();
  v_actor   uuid := app.actor();
  v_kind    text;
BEGIN
  IF app.permission_rank(p_permission) IS NULL OR v_ws IS NULL OR v_actor IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  SELECT a.kind INTO v_kind FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
  IF v_kind IS NULL OR v_kind = 'system' THEN
    RETURN '{}'::uuid[];
  END IF;
  IF v_kind = 'person' AND app.lookup_workspace_role() IN ('owner', 'admin') THEN
    RETURN coalesce((SELECT array_agg(t.id) FROM app.teams t WHERE t.workspace_id = v_ws), '{}'::uuid[]);
  END IF;
  RETURN app.member_team_ids(p_permission);
END
$$;

CREATE FUNCTION app.held_role_ids() RETURNS uuid[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws    uuid := app.workspace_id();
  v_actor uuid := app.actor();
  v_ref   uuid;
BEGIN
  IF v_ws IS NULL OR v_actor IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  SELECT a.ref_id INTO v_ref FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws AND a.kind = 'person';
  IF v_ref IS NULL OR app.lookup_workspace_role() IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  RETURN coalesce((
    SELECT array_agg(rm.role_id) FROM app.role_members rm WHERE rm.person_id = v_ref AND rm.workspace_id = v_ws
  ), '{}'::uuid[]);
END
$$;

CREATE FUNCTION app.acl_grant_ids(p_resource_type text, p_permission text) RETURNS uuid[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws    uuid := app.workspace_id();
  v_actor uuid := app.actor();
  v_need  integer := app.permission_rank(p_permission);
  v_kind  text;
  v_ref   uuid;
  v_teams uuid[];
  v_roles uuid[];
BEGIN
  IF v_need IS NULL OR v_ws IS NULL OR v_actor IS NULL OR p_resource_type IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  SELECT a.kind, a.ref_id INTO v_kind, v_ref FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
  IF v_kind IS NULL OR v_kind = 'system' THEN
    RETURN '{}'::uuid[];
  END IF;
  IF v_kind = 'person' AND app.lookup_workspace_role() IS NULL THEN
    RETURN '{}'::uuid[];   -- suspended or without membership; a guest (role 'guest') keeps its person and role grants
  END IF;
  v_teams := app.member_team_ids('read');
  v_roles := app.held_role_ids();
  RETURN coalesce((
    SELECT array_agg(DISTINCT e.resource_id)
    FROM app.acl_entries e
    WHERE e.workspace_id = v_ws
      AND e.resource_type = p_resource_type
      AND app.permission_rank(e.permission) >= v_need
      AND (
        (e.subject_type = 'person' AND v_kind = 'person' AND e.subject_id = v_ref)
        OR (e.subject_type = 'team' AND e.subject_id = ANY (v_teams))
        OR (e.subject_type = 'role' AND e.subject_id = ANY (v_roles))
      )
  ), '{}'::uuid[]);
END
$$;

REVOKE ALL ON FUNCTION app.member_team_ids(text), app.readable_team_ids(text), app.held_role_ids(), app.acl_grant_ids(text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.member_team_ids(text), app.readable_team_ids(text), app.held_role_ids(), app.acl_grant_ids(text, text)
  TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.member_team_ids(text) OWNER TO manythreads_system;
ALTER FUNCTION app.readable_team_ids(text) OWNER TO manythreads_system;
ALTER FUNCTION app.held_role_ids() OWNER TO manythreads_system;
ALTER FUNCTION app.acl_grant_ids(text, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

-- Read policies in the hoisted form. Semantics are unchanged (the tests in kernel/test/rls pass untouched); only the cost is. --------
-- teams: members of the team, workspace admins every team of their workspace. The admin branch is a boolean InitPlan of
-- its own, not only the array: the array is fixed when the statement starts, and `INSERT INTO teams ... RETURNING` checks the
-- new row against this policy, so a row the statement itself creates must be visible by a rule that does not look it up.
DROP POLICY teams_select ON app.teams;
CREATE POLICY teams_select ON app.teams FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_workspace_admin()))
  OR id = ANY ((SELECT app.member_team_ids('read'))::uuid[])
);

-- team_members: the roster of every team the caller may read.
DROP POLICY team_members_select ON app.team_members;
CREATE POLICY team_members_select ON app.team_members FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);

-- events: team rows to the team's members only (admins do not read team events); workspace rows to admins.
DROP POLICY events_select ON app.events;
CREATE POLICY events_select ON app.events FOR SELECT USING (
  (SELECT app.is_system())
  OR team_id = ANY ((SELECT app.member_team_ids('read'))::uuid[])
  OR (team_id IS NULL AND workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_workspace_admin()))
);

-- capability_grants and entity_links: members of the team only.
DROP POLICY capability_grants_select ON app.capability_grants;
CREATE POLICY capability_grants_select ON app.capability_grants FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.member_team_ids('read'))::uuid[])
);

DROP POLICY entity_links_team ON app.entity_links;
CREATE POLICY entity_links_team ON app.entity_links FOR ALL
  USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.member_team_ids('read'))::uuid[]))
  WITH CHECK ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.member_team_ids('read'))::uuid[]));

-- scoped_kv: team scope by membership, person scope own, workspace scope for non-guest members.
DROP POLICY scoped_kv_select ON app.scoped_kv;
CREATE POLICY scoped_kv_select ON app.scoped_kv FOR SELECT USING (
  (SELECT app.is_system())
  OR (scope_type = 'team' AND scope_id = ANY ((SELECT app.member_team_ids('read'))::uuid[]))
  OR (scope_type = 'person' AND scope_id = (SELECT app.person_id()))
  OR (scope_type = 'workspace' AND scope_id = (SELECT app.workspace_id())
      AND (SELECT app.workspace_role()) IN ('owner', 'admin', 'member'))
);

-- invitations: workspace admins see all of their workspace, a team lead the invitations of the teams they lead.
DROP POLICY invitations_select ON app.invitations;
CREATE POLICY invitations_select ON app.invitations FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id())
      AND ((SELECT app.is_workspace_admin()) OR team_id = ANY ((SELECT app.member_team_ids('manage'))::uuid[])))
);

-- acl_entries: admins read all; a subject reads its own grants (person, team it belongs to, role it holds).
DROP POLICY acl_entries_select ON app.acl_entries;
CREATE POLICY acl_entries_select ON app.acl_entries FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (
        (SELECT app.is_workspace_admin())
        OR (subject_type = 'person' AND subject_id = (SELECT app.person_id()))
        OR (subject_type = 'team' AND subject_id = ANY ((SELECT app.member_team_ids('read'))::uuid[]))
        OR (subject_type = 'role' AND subject_id = ANY ((SELECT app.held_role_ids())::uuid[]))
  ))
);
