-- connections 0006: what an admin sees of the connectors, the daily usage count, the owner move and the first step of offboarding (PLAN Bundle D, P16-11). Forward-only: never edit once applied.
--
--   connection_usage_daily       one row per connection and day: how many tool calls went through it and how many failed. System only: a person's session cannot read or
--                                write it. The counter is bumped through the narrow definer function `app.connection_usage_bump`, which takes only the connection and whether the call worked.
--   connections_guard (replaced) the owner of a team or workspace connection may change, by the system role only, and only to a person who can answer for it (a lead of the team,
--                                or an admin of the workspace). Every other refusal of 0001 stays.
--   connections_resolve_people   the people a typed name or @handle can mean, among those who share a team with the caller (the free-time tool; the model never guesses an address).
--   connections_admin_people     per person and provider: which services were granted, the sign-in's state, when it was last used. An admin only. Never an account address, never a token.
--   connections_offboard_start   the first step of removing a person's connections: their own are switched off at once, the team and workspace connections they own move to someone
--                                who can answer for them. System only. The rest (asking the providers to forget, deleting) is a job of the plugin.

-- connection_usage_daily (S) ----------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.connection_usage_daily (
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES app.connections (id) ON DELETE CASCADE,
  -- the provider of a person connection (`google`), else the kind of the connection (`email`); copied so a count survives a change of the connection's sign-in row
  provider      text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  day           date NOT NULL,
  calls         integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  failures      integer NOT NULL DEFAULT 0 CHECK (failures >= 0 AND failures <= calls),
  PRIMARY KEY (connection_id, day)
);
CREATE INDEX connection_usage_daily_workspace ON app.connection_usage_daily (workspace_id, day);
COMMENT ON TABLE app.connection_usage_daily IS 'rls: system — S: tool calls per connection and day (calls, failures); no privilege for manythreads_app. Bumped through app.connection_usage_bump, read by the admin health route as the system role.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id ON app.connection_usage_daily
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- One tool call went through the connection (`p_ok`: it worked). The row of the day is made on first use. The caller must be in the connection's workspace (the transaction's
-- workspace, set by the platform); a connection of another workspace, or none, changes nothing. Content-blind: nothing about the call is kept but the two counts.
CREATE FUNCTION app.connection_usage_bump(p_connection_id uuid, p_ok boolean) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws       uuid := app.workspace_id();
  v_provider text;
BEGIN
  IF v_ws IS NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(o.provider, c.kind) INTO v_provider
    FROM app.connections c LEFT JOIN app.connection_oauth o ON o.connection_id = c.id
   WHERE c.id = p_connection_id AND c.workspace_id = v_ws;
  IF v_provider IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO app.connection_usage_daily AS u (workspace_id, connection_id, provider, day, calls, failures)
    VALUES (v_ws, p_connection_id, v_provider, (now() AT TIME ZONE 'utc')::date, 1, CASE WHEN p_ok THEN 0 ELSE 1 END)
    ON CONFLICT (connection_id, day) DO UPDATE SET calls = u.calls + 1, failures = u.failures + CASE WHEN p_ok THEN 0 ELSE 1 END;
END
$$;

-- The guard, replaced ----------------------------------------------------------------------------------------------------------------------------
-- Same as 0001 with one change: the owner of a team or workspace connection can move. Only the system role can do it (the offboarding step), only for those two scopes, and
-- only to a person who is a lead of the team (team connection) or an owner or admin of the workspace (team or workspace connection), active, in the same workspace.
-- Nobody else can change the owner, and nothing else about a connection changes under a person.
CREATE OR REPLACE FUNCTION app.connections_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_owner_ws   uuid;
  v_owner_kind text;
  v_ok         boolean;
BEGIN
  SELECT a.workspace_id, a.kind INTO v_owner_ws, v_owner_kind FROM app.actors a WHERE a.id = NEW.owner_id;
  IF v_owner_ws IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'connections.owner_id must be an actor of the row''s workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.scope = 'person' AND v_owner_kind IS DISTINCT FROM 'person' THEN
    RAISE EXCEPTION 'a person connection is owned by a person' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    -- an owner move: the system role, a team or workspace connection, a new owner who can answer for it
    IF session_user <> 'manythreads_system' THEN
      RAISE EXCEPTION 'a connection''s owner can be moved only by the platform when its owner leaves' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.scope NOT IN ('team', 'workspace') THEN
      RAISE EXCEPTION 'a person connection stays with its person' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT EXISTS (
      SELECT 1
        FROM app.actors a
        JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id AND p.status = 'active'
        JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id
       WHERE a.id = NEW.owner_id AND a.kind = 'person' AND a.workspace_id = NEW.workspace_id
         AND (wm.role IN ('owner', 'admin')
              OR (NEW.scope = 'team' AND wm.role <> 'guest'
                  AND EXISTS (SELECT 1 FROM app.team_members tm WHERE tm.team_id = NEW.team_id AND tm.actor_id = a.id AND tm.role = 'lead')))
    ) INTO v_ok;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'the new owner of a connection must be a lead of its team or an admin of the workspace' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  -- not app.is_system(): inside this definer function that is always true (it reads current_user); the login that opened the session is what says who is asking
  IF session_user = 'manythreads_system' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.has_credentials THEN
      RAISE EXCEPTION 'has_credentials is kept by the platform' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.has_credentials IS DISTINCT FROM OLD.has_credentials THEN
    RAISE EXCEPTION 'a connection''s workspace, team, scope, owner, kind and short name cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

-- Who a typed name means ---------------------------------------------------------------------------------------------------------------------------
-- The free-time tool is given names (or @handles), never addresses. For each name this answers the active, non-guest people who share a team with the caller whose display name
-- starts with it (or any later word of it) or whose address starts with it, as plain text (no wildcard). The caller is checked with lookup_workspace_role (inside a definer
-- function app.is_system() is TRUE). At most 5 names and 5 matches per name; the caller themself is not an answer. The address is returned to the tool code, which uses it only to
-- ask the provider and never passes it on to a model.
CREATE FUNCTION app.connections_resolve_people(p_names text[]) RETURNS TABLE (name_key text, person_id uuid, actor_id uuid, display_name text, email text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_role text := app.lookup_workspace_role();
  v_ws   uuid := app.workspace_id();
  v_self uuid := app.actor();
BEGIN
  IF v_self IS NULL OR v_role IS NULL OR v_role = 'guest' OR v_ws IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT n.key, m.person_id, m.actor_id, m.display_name, m.email
    FROM (SELECT DISTINCT lower(btrim(replace(x, '@', ''))) AS key FROM unnest(p_names[1:5]) x WHERE btrim(replace(x, '@', '')) <> '') n
    CROSS JOIN LATERAL (
      SELECT p.id AS person_id, a.id AS actor_id, p.display_name, p.primary_email AS email
        FROM app.actors a
        JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id AND p.status = 'active'
        JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id AND wm.role <> 'guest'
       WHERE a.kind = 'person' AND a.workspace_id = v_ws AND a.id <> v_self
         AND EXISTS (SELECT 1 FROM app.team_members t1 JOIN app.team_members t2 ON t2.team_id = t1.team_id
                      WHERE t1.actor_id = v_self AND t2.actor_id = a.id)
         AND (starts_with(lower(p.display_name), n.key) OR strpos(lower(p.display_name), ' ' || n.key) > 0 OR starts_with(lower(p.primary_email), n.key))
       ORDER BY p.display_name, a.id
       LIMIT 5
    ) m;
END
$$;

-- What an admin sees of the people's sign-ins ----------------------------------------------------------------------------------------------------
-- One row per person connection: whose it is, the provider, the scopes the person agreed to (the code maps them to services), whether the sign-in works, when it was made and when it was
-- last used (the newest day with a counted call). An owner or admin only (lookup_workspace_role); anybody else gets nothing. The account address (`account_label`) and every token stay out.
CREATE FUNCTION app.connections_admin_people() RETURNS TABLE (
  connection_id uuid, person_id uuid, display_name text, provider text, status text, state text, scopes text[], connected_at timestamptz, refreshed_at timestamptz, last_used_on date
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_role text := app.lookup_workspace_role();
  v_ws   uuid := app.workspace_id();
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') OR v_ws IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT c.id, p.id, p.display_name, o.provider, c.status, o.state, o.scopes, c.created_at, o.refreshed_at,
         (SELECT max(u.day) FROM app.connection_usage_daily u WHERE u.connection_id = c.id)
    FROM app.connections c
    JOIN app.connection_oauth o ON o.connection_id = c.id
    JOIN app.actors a ON a.id = c.owner_id AND a.kind = 'person'
    JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id
   WHERE c.workspace_id = v_ws AND c.scope = 'person'
   ORDER BY p.display_name, o.provider
   LIMIT 2000;
END
$$;

-- Offboarding, step one (system only) -------------------------------------------------------------------------------------------------------------
-- Fails closed first: every person connection of the person is switched off at once (the tool source refuses a disabled connection). Then each team or workspace connection they own
-- moves to the longest-serving lead of its team, else to `p_fallback_owner` (the admin who acted) when it is an owner or admin, else to the longest-serving owner or admin of the
-- workspace other than the person. Answers one row per connection touched. The new owner is checked again by the guard trigger.
CREATE FUNCTION app.connections_offboard_start(p_person_id uuid, p_fallback_owner uuid DEFAULT NULL)
  RETURNS TABLE (connection_id uuid, scope text, action text, new_owner_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws     uuid := app.workspace_id();
  v_actor  uuid;
  v_admin  uuid;
  v_fall   uuid;
  r        record;
  v_new    uuid;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the platform removes a person''s connections' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT a.id INTO v_actor FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id
   WHERE a.kind = 'person' AND p.id = p_person_id AND a.workspace_id = v_ws;
  IF v_actor IS NULL THEN
    RETURN;
  END IF;
  -- the admin to fall back to: the one named, if still an owner or admin, else the longest-serving one
  SELECT a.id INTO v_fall
    FROM app.actors a
    JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id AND p.status = 'active'
    JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id AND wm.role IN ('owner', 'admin')
   WHERE a.kind = 'person' AND a.workspace_id = v_ws AND a.id = p_fallback_owner AND a.id <> v_actor;
  IF v_fall IS NULL THEN
    SELECT a.id INTO v_admin
      FROM app.actors a
      JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id AND p.status = 'active'
      JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id AND wm.role IN ('owner', 'admin')
     WHERE a.kind = 'person' AND a.workspace_id = v_ws AND a.id <> v_actor
     ORDER BY wm.created_at, a.id LIMIT 1;
    v_fall := v_admin;
  END IF;

  FOR r IN
    WITH off AS (
      UPDATE app.connections c SET status = 'disabled', updated_at = now()
       WHERE c.workspace_id = v_ws AND c.scope = 'person' AND c.owner_id = v_actor
      RETURNING c.id AS cid, c.scope AS cscope)
    SELECT off.cid AS id, off.cscope AS scope FROM off
  LOOP
    connection_id := r.id; scope := r.scope; action := 'disabled'; new_owner_id := NULL;
    RETURN NEXT;
  END LOOP;

  FOR r IN SELECT c.id, c.scope, c.team_id FROM app.connections c WHERE c.workspace_id = v_ws AND c.scope IN ('team', 'workspace') AND c.owner_id = v_actor ORDER BY c.created_at, c.id LOOP
    v_new := NULL;
    IF r.scope = 'team' THEN
      SELECT tm.actor_id INTO v_new
        FROM app.team_members tm
        JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' AND a.workspace_id = tm.workspace_id
        JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id AND p.status = 'active'
        JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id AND wm.role <> 'guest'
       WHERE tm.team_id = r.team_id AND tm.role = 'lead' AND tm.actor_id <> v_actor
       ORDER BY tm.created_at, tm.actor_id LIMIT 1;
    END IF;
    v_new := coalesce(v_new, v_fall);
    IF v_new IS NULL THEN
      -- nobody can take it: it is switched off and stays with its owner until an admin deals with it
      UPDATE app.connections SET status = 'disabled', updated_at = now() WHERE id = r.id;
      connection_id := r.id; scope := r.scope; action := 'disabled'; new_owner_id := NULL;
      RETURN NEXT;
      CONTINUE;
    END IF;
    UPDATE app.connections SET owner_id = v_new, updated_at = now() WHERE id = r.id;
    connection_id := r.id; scope := r.scope; action := 'moved'; new_owner_id := v_new;
    RETURN NEXT;
  END LOOP;
END
$$;

-- Row level security ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.connection_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_usage_daily_system ON app.connection_usage_daily FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: a person's session cannot even name the table

-- Owned by the system role like every other definer function.
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.connection_usage_bump(uuid, boolean) OWNER TO manythreads_system;
ALTER FUNCTION app.connections_resolve_people(text[]) OWNER TO manythreads_system;
ALTER FUNCTION app.connections_admin_people() OWNER TO manythreads_system;
ALTER FUNCTION app.connections_offboard_start(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.connections_guard() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.connection_usage_bump(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.connections_resolve_people(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.connections_admin_people() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.connections_offboard_start(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.connection_usage_bump(uuid, boolean) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.connections_resolve_people(text[]) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.connections_admin_people() TO manythreads_app, manythreads_system;
-- the offboarding step is the system role's alone: the application role cannot execute it at all
GRANT EXECUTE ON FUNCTION app.connections_offboard_start(uuid, uuid) TO manythreads_system;
