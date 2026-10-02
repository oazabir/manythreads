-- channels 0001: channel_groups, channels, channel_members, the visibility set app.visible_channel_ids() and the definer
-- functions around them (PLAN.md A.3, P3-01). Forward-only: never edit once applied.
--
-- WHO SEES A CHANNEL. Channel visibility is not team-based alone (a private channel, a DM, a guest's one granted channel), so
-- the hoisted idiom of kernel 0011 needs a helper of our own: app.visible_channel_ids(permission) returns the uuid[] of channels
-- the CALLER may read ('read') or write in ('post'), and every policy of this plugin probes it once per statement:
--
--     channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
--
-- It is SECURITY DEFINER, owned by manythreads_system, answers only about the caller (app.actor(), app.workspace_id()) and checks
-- the caller with app.lookup_workspace_role() and the actor row, never app.is_system() (always true inside a definer owned by the
-- system role; MISTAKES P2 review). The set is the union of:
--   * public channels (private = false, kind 'channel') of the teams the caller sits in, plus every team for a workspace
--     owner/admin (app.readable_team_ids), never for a guest;
--   * private channels, DMs and bot conversations the caller has a channel_members row for (never a guest: a guest's access is
--     an ACL grant only, so removing the grant removes it);
--   * channels the caller holds an acl_entries grant on (resource_type 'channel', person, team or role subject) at >= the permission.
-- 'post' is the same set without archived channels, and a guest needs an explicit 'post' grant (Lena has 'read').
-- Workspace admins read the public channels of every team but NOT the private ones or DMs. A private channel is entered through
-- app.channels_add_member: a lead or workspace admin of the channel's team adds anyone who is on that team (an admin who is not on
-- the team must be put on its roster first, which is visible), and the route writes channel.member.added.
--
-- app.channel_can(channel, permission) is the single-row check (routes, UPDATE policies): read/post answer from the same set;
-- 'manage' is "lead of the channel's team or workspace admin" (a team channel only). It is registered in resource_kinds so ACL
-- entries of resource_type 'channel' are valid, but app.can('channel', ...) must not be used for the decision: lookup_can gives a
-- workspace admin every resource, private channels included. Use app.channel_can.

-- channel_groups (T) -------------------------------------------------------------------------------------------------------
CREATE TABLE app.channel_groups (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (name <> '' AND length(name) <= 80),
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);
CREATE INDEX channel_groups_team_position ON app.channel_groups (team_id, position);
CREATE INDEX channel_groups_workspace ON app.channel_groups (workspace_id);
COMMENT ON TABLE app.channel_groups IS 'rls: team — T: sidebar groups of a team; members and workspace admins read, leads and admins write.';

-- channels (C) -------------------------------------------------------------------------------------------------------------
CREATE TABLE app.channels (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid REFERENCES app.teams (id) ON DELETE CASCADE,
  group_id     uuid REFERENCES app.channel_groups (id) ON DELETE SET NULL,
  name         text NOT NULL DEFAULT '',
  kind         text NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel', 'dm', 'bot_conversation')),
  private      boolean NOT NULL DEFAULT false,
  purpose      text NOT NULL DEFAULT '' CHECK (length(purpose) <= 250),
  dm_key       text,
  bot_id       uuid,
  position     integer NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channels_name_shape CHECK (kind <> 'channel' OR name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT channels_team_channel CHECK (kind <> 'channel' OR team_id IS NOT NULL),
  CONSTRAINT channels_dm_shape CHECK (kind <> 'dm' OR (dm_key IS NOT NULL AND private AND team_id IS NULL)),
  CONSTRAINT channels_bot_shape CHECK (kind <> 'bot_conversation' OR (bot_id IS NOT NULL AND private)),
  CONSTRAINT channels_private_kinds CHECK (kind = 'channel' OR private)
);
CREATE UNIQUE INDEX channels_team_name ON app.channels (team_id, name) WHERE kind = 'channel';
CREATE UNIQUE INDEX channels_dm_key ON app.channels (workspace_id, dm_key) WHERE kind = 'dm';
CREATE INDEX channels_group ON app.channels (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX channels_team ON app.channels (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX channels_workspace ON app.channels (workspace_id);
COMMENT ON TABLE app.channels IS 'rls: team — C: channels, DMs and bot conversations; the policy probes app.visible_channel_ids(); only a team lead or workspace admin writes a team channel.';

-- channel_members (C; P) ---------------------------------------------------------------------------------------------------
CREATE TABLE app.channel_members (
  channel_id uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  muted      boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, person_id)
);
CREATE INDEX channel_members_person ON app.channel_members (person_id);
COMMENT ON TABLE app.channel_members IS 'rls: team — C;P: who sees a private channel or DM, and who joined a public one; writes only through app.channels_join/add_member/remove_member.';

-- channel_template_syncs (S) ---------------------------------------------------------------------------------------------
-- One row per team whose template channels were created, so a channel a lead renamed or archived is not created again by a
-- later sync (the get-or-create alone would make a second "#general" once the first was renamed).
CREATE TABLE app.channel_template_syncs (
  team_id          uuid PRIMARY KEY REFERENCES app.teams (id) ON DELETE CASCADE,
  template_id      text NOT NULL,
  template_version integer NOT NULL,
  synced_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.channel_template_syncs IS 'rls: system — S: teams whose template channels exist; written by app.channels_sync_template only.';

-- Visibility ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION app.visible_channel_ids(p_permission text DEFAULT 'read') RETURNS uuid[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws    uuid := app.workspace_id();
  v_actor uuid := app.actor();
  v_kind  text;
  v_ref   uuid;
  v_role  text;
  v_teams uuid[];
  v_acl   uuid[];
BEGIN
  IF p_permission NOT IN ('read', 'post') OR v_ws IS NULL OR v_actor IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  SELECT a.kind, a.ref_id INTO v_kind, v_ref FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
  IF v_kind IS NULL OR v_kind = 'system' THEN
    RETURN '{}'::uuid[];
  END IF;
  IF v_kind = 'person' THEN
    v_role := app.lookup_workspace_role();   -- NULL: suspended or no membership
    IF v_role IS NULL THEN
      RETURN '{}'::uuid[];
    END IF;
  END IF;
  v_teams := app.readable_team_ids(p_permission);   -- {} for a guest
  v_acl := app.acl_grant_ids('channel', p_permission);
  RETURN coalesce((
    SELECT array_agg(DISTINCT s.id) FROM (
      SELECT c.id FROM app.channels c
       WHERE c.workspace_id = v_ws AND c.kind = 'channel' AND NOT c.private AND c.team_id = ANY (v_teams)
         AND (p_permission = 'read' OR c.archived_at IS NULL)
      UNION
      SELECT c.id FROM app.channel_members m JOIN app.channels c ON c.id = m.channel_id
       WHERE v_kind = 'person' AND m.person_id = v_ref AND c.workspace_id = v_ws AND v_role <> 'guest'
         AND (p_permission = 'read' OR c.archived_at IS NULL)
      UNION
      SELECT c.id FROM app.channels c
       WHERE c.workspace_id = v_ws AND c.id = ANY (v_acl) AND (p_permission = 'read' OR c.archived_at IS NULL)
    ) s
  ), '{}'::uuid[]);
END
$$;

-- One channel: 'read' and 'post' from the set above; 'manage' = lead of the channel's team or workspace admin (a team channel only).
CREATE FUNCTION app.lookup_channel_can(p_channel_id uuid, p_permission text) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws   uuid := app.workspace_id();
  v_team uuid;
  v_kind text;
BEGIN
  IF p_channel_id IS NULL OR v_ws IS NULL OR app.actor() IS NULL THEN
    RETURN false;
  END IF;
  IF p_permission = 'manage' THEN
    SELECT c.team_id, c.kind INTO v_team, v_kind FROM app.channels c WHERE c.id = p_channel_id AND c.workspace_id = v_ws;
    RETURN v_kind = 'channel' AND v_team IS NOT NULL AND app.lookup_can_team(v_team, 'manage');
  END IF;
  RETURN p_channel_id = ANY (app.visible_channel_ids(p_permission));
END
$$;

CREATE FUNCTION app.channel_can(p_channel_id uuid, p_permission text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT app.is_system() OR app.lookup_channel_can(p_channel_id, p_permission) $$;

-- The people who can read a channel right now (for live pushes). The same rules as visible_channel_ids, from the channel's side:
-- a test compares the two for every persona. Only for callers who can read the channel themselves (and the system role).
CREATE FUNCTION app.channel_audience(p_channel_id uuid) RETURNS TABLE (person_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws uuid := app.workspace_id();
BEGIN
  IF session_user <> 'manythreads_system' AND NOT app.lookup_channel_can(p_channel_id, 'read') THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT DISTINCT p.id
  FROM app.channels c
  JOIN app.people p ON p.workspace_id = c.workspace_id AND p.status = 'active'
  JOIN app.workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.person_id = p.id
  WHERE c.id = p_channel_id AND c.workspace_id = v_ws
    AND (
      (c.kind = 'channel' AND NOT c.private AND wm.role <> 'guest' AND (
         wm.role IN ('owner', 'admin')
         OR EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                     WHERE tm.team_id = c.team_id AND a.ref_id = p.id)))
      OR (wm.role <> 'guest' AND EXISTS (SELECT 1 FROM app.channel_members m WHERE m.channel_id = c.id AND m.person_id = p.id))
      OR EXISTS (
        SELECT 1 FROM app.acl_entries e
         WHERE e.workspace_id = c.workspace_id AND e.resource_type = 'channel' AND e.resource_id = c.id
           AND (
             (e.subject_type = 'person' AND e.subject_id = p.id)
             OR (e.subject_type = 'team' AND wm.role <> 'guest' AND EXISTS (
                   SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                    WHERE tm.team_id = e.subject_id AND a.ref_id = p.id))
             OR (e.subject_type = 'role' AND EXISTS (
                   SELECT 1 FROM app.role_members rm WHERE rm.role_id = e.subject_id AND rm.person_id = p.id))
           ))
    );
END
$$;

-- The team of a channel, for a caller who can read or manage it (an admin adding someone to a private channel cannot SELECT it).
CREATE FUNCTION app.channel_team_id(p_channel_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT c.team_id FROM app.channels c
   WHERE c.id = p_channel_id AND c.workspace_id = app.workspace_id()
     AND (app.lookup_channel_can(c.id, 'read') OR app.lookup_channel_can(c.id, 'manage'))
$$;

-- Guards -------------------------------------------------------------------------------------------------------------------
-- A channel keeps its identity; its group belongs to the same team; its team belongs to its workspace.
CREATE FUNCTION app.channels_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.teams t WHERE t.id = NEW.team_id AND t.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'channels.team_id must belong to the channel''s workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.group_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.channel_groups g
        WHERE g.id = NEW.group_id AND g.team_id IS NOT DISTINCT FROM NEW.team_id AND g.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'a channel''s group must belong to the same team' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND session_user <> 'manythreads_system' THEN
    IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.team_id IS DISTINCT FROM OLD.team_id
       OR NEW.kind <> OLD.kind OR NEW.private <> OLD.private OR NEW.dm_key IS DISTINCT FROM OLD.dm_key
       OR NEW.bot_id IS DISTINCT FROM OLD.bot_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a channel''s team, kind, privacy and owner never change' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER channels_guard BEFORE INSERT OR UPDATE ON app.channels FOR EACH ROW EXECUTE FUNCTION app.channels_guard();

-- Membership: the only doors to channel_members (the table is read-only for manythreads_app) ----------------------------------
-- A workspace member (not a guest) joins a public channel they can read.
CREATE FUNCTION app.channels_join(p_channel_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws     uuid := app.workspace_id();
  v_person uuid;
  v_role   text := app.lookup_workspace_role();
  c        app.channels;
  n        integer;
BEGIN
  SELECT a.ref_id INTO v_person FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = v_ws;
  SELECT * INTO c FROM app.channels WHERE id = p_channel_id AND workspace_id = v_ws;
  IF v_person IS NULL OR v_role IS NULL OR v_role = 'guest' OR NOT FOUND OR c.kind <> 'channel' OR c.private
     OR NOT (p_channel_id = ANY (app.visible_channel_ids('read'))) THEN
    RAISE EXCEPTION 'you cannot join this channel' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'this channel is archived' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.channel_members (channel_id, person_id) VALUES (p_channel_id, v_person) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;

-- A lead or workspace admin adds anyone on the channel's team (themselves included: that is how an admin enters a private channel).
CREATE FUNCTION app.channels_add_member(p_channel_id uuid, p_person_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws  uuid := app.workspace_id();
  c     app.channels;
  v_role text;
  n     integer;
BEGIN
  IF NOT app.lookup_channel_can(p_channel_id, 'manage') THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may add members' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO c FROM app.channels WHERE id = p_channel_id AND workspace_id = v_ws;
  IF c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'this channel is archived' USING ERRCODE = 'check_violation';
  END IF;
  SELECT wm.role INTO v_role
    FROM app.people p JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id
   WHERE p.id = p_person_id AND p.workspace_id = v_ws AND p.status = 'active';
  IF v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'that person cannot be added to a channel (a guest gets access through a grant)' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                  WHERE tm.team_id = c.team_id AND a.ref_id = p_person_id) THEN
    RAISE EXCEPTION 'that person is not on the channel''s team' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.channel_members (channel_id, person_id) VALUES (p_channel_id, p_person_id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;

-- Remove a person (a lead or admin) or leave (the person themself; not a DM).
CREATE FUNCTION app.channels_remove_member(p_channel_id uuid, p_person_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws     uuid := app.workspace_id();
  v_person uuid;
  c        app.channels;
  n        integer;
BEGIN
  SELECT a.ref_id INTO v_person FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = v_ws;
  SELECT * INTO c FROM app.channels WHERE id = p_channel_id AND workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'you cannot change this channel' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_person IS NOT NULL AND v_person = p_person_id AND app.lookup_workspace_role() IS NOT NULL THEN
    NULL;   -- leaving: one's own row
  ELSIF NOT app.lookup_channel_can(p_channel_id, 'manage') THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may remove members' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF c.kind = 'dm' THEN
    RAISE EXCEPTION 'nobody leaves a direct message' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM app.channel_members WHERE channel_id = p_channel_id AND person_id = p_person_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;

-- Team templates ------------------------------------------------------------------------------------------------------------
-- Creates a team's template channels (group "Channels", then each channel of teams.template_definition) once: get-or-create on
-- (team_id, name), and a marker row so a renamed or archived channel is never recreated. Returns the channels this call created
-- (so the caller can emit channel.channel.created). Callable by a member of the team (the directory request triggers it for teams
-- seeded without an event) and by the system role (the team.template.applied subscriber).
CREATE FUNCTION app.channels_sync_template(p_team_id uuid) RETURNS TABLE (channel_id uuid, name text, private boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws       uuid;
  v_def      jsonb;
  v_group    uuid;
  v_channel  jsonb;
  v_name     text;
  v_id       uuid;
  v_ord      integer;
BEGIN
  IF session_user <> 'manythreads_system' AND NOT app.lookup_can_team(p_team_id, 'read') THEN
    RAISE EXCEPTION 'you cannot see this team' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('channels.sync:' || p_team_id::text, 0));
  SELECT t.workspace_id, t.template_definition INTO v_ws, v_def FROM app.teams t WHERE t.id = p_team_id;
  IF v_ws IS NULL OR v_def IS NULL OR jsonb_typeof(v_def -> 'channels') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM app.channel_template_syncs s WHERE s.team_id = p_team_id) THEN
    RETURN;
  END IF;
  INSERT INTO app.channel_groups (workspace_id, team_id, name, position) VALUES (v_ws, p_team_id, 'Channels', 0)
    ON CONFLICT (team_id, name) DO NOTHING;
  SELECT g.id INTO v_group FROM app.channel_groups g WHERE g.team_id = p_team_id AND g.name = 'Channels';
  FOR v_channel, v_ord IN SELECT e.value, e.ordinality::integer FROM jsonb_array_elements(v_def -> 'channels') WITH ORDINALITY e LOOP
    v_name := regexp_replace(v_channel ->> 'name', '^#', '');
    CONTINUE WHEN v_name IS NULL OR v_name !~ '^[a-z0-9][a-z0-9-]{0,62}$';
    v_id := NULL;
    INSERT INTO app.channels (workspace_id, team_id, group_id, name, kind, private, purpose, position)
    VALUES (v_ws, p_team_id, v_group, v_name, 'channel', coalesce((v_channel ->> 'private')::boolean, false),
            left(coalesce(v_channel ->> 'purpose', ''), 250), v_ord)
    ON CONFLICT (team_id, name) WHERE kind = 'channel' DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      IF coalesce((v_channel ->> 'private')::boolean, false) THEN
        -- A private template channel starts with the team's leads.
        INSERT INTO app.channel_members (channel_id, person_id)
        SELECT v_id, a.ref_id FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
         WHERE tm.team_id = p_team_id AND tm.role = 'lead'
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN QUERY SELECT v_id, v_name, coalesce((v_channel ->> 'private')::boolean, false);
    END IF;
  END LOOP;
  INSERT INTO app.channel_template_syncs (team_id, template_id, template_version)
  VALUES (p_team_id, coalesce(v_def ->> 'id', ''), coalesce((v_def ->> 'version')::integer, 1))
  ON CONFLICT DO NOTHING;
END
$$;

-- Row level security ----------------------------------------------------------------------------------------------------------
ALTER TABLE app.channel_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_groups_select ON app.channel_groups FOR SELECT
  USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY channel_groups_insert ON app.channel_groups FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND app.can_in_team(team_id, 'manage')));
CREATE POLICY channel_groups_update ON app.channel_groups FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND app.can_in_team(team_id, 'manage')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND app.can_in_team(team_id, 'manage')));
CREATE POLICY channel_groups_delete ON app.channel_groups FOR DELETE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND app.can_in_team(team_id, 'manage')));

ALTER TABLE app.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channels FORCE ROW LEVEL SECURITY;
CREATE POLICY channels_select ON app.channels FOR SELECT
  USING ((SELECT app.is_system()) OR id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
-- A team channel is written by a lead or workspace admin of its team. DMs and bot conversations are created by their own plugins
-- through system-owned functions, never by this policy. `INSERT ... RETURNING` of a private channel cannot see its own new row
-- (the visibility array is fixed at statement start): draw the id first, insert without RETURNING, read afterwards.
CREATE POLICY channels_insert ON app.channels FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (
    kind = 'channel' AND workspace_id = (SELECT app.workspace_id()) AND team_id IS NOT NULL
    AND created_by IS NOT DISTINCT FROM (SELECT app.actor()) AND app.can_in_team(team_id, 'manage')));
CREATE POLICY channels_update ON app.channels FOR UPDATE
  USING ((SELECT app.is_system()) OR (kind = 'channel' AND team_id IS NOT NULL AND app.can_in_team(team_id, 'manage')))
  WITH CHECK ((SELECT app.is_system()) OR (kind = 'channel' AND team_id IS NOT NULL AND app.can_in_team(team_id, 'manage')));

ALTER TABLE app.channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_members FORCE ROW LEVEL SECURITY;
-- Your own rows, and the members of any channel you can read, except for a guest (a guest sees no member lists).
CREATE POLICY channel_members_select ON app.channel_members FOR SELECT USING (
  (SELECT app.is_system())
  OR person_id = (SELECT app.person_id())
  OR (channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
      AND (SELECT app.workspace_role()) IN ('owner', 'admin', 'member'))
);

-- Written by the definer functions above (they run as manythreads_system) and by system code: no caller writes it directly.
CREATE POLICY channel_members_system ON app.channel_members FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

ALTER TABLE app.channel_template_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_template_syncs FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_template_syncs_system ON app.channel_template_syncs FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- Resource kind: ACL entries may name a channel (a guest invitation grants one). Not for app.can() decisions: see the header.
INSERT INTO app.resource_kinds (resource_type, table_name, team_column) VALUES ('channel', 'channels', NULL)
  ON CONFLICT DO NOTHING;

-- Privileges ------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON app.channel_groups TO manythreads_app;
GRANT SELECT, INSERT, UPDATE ON app.channels TO manythreads_app;
GRANT SELECT ON app.channel_members TO manythreads_app;
REVOKE ALL ON app.channel_template_syncs FROM manythreads_app;

REVOKE ALL ON FUNCTION app.visible_channel_ids(text), app.lookup_channel_can(uuid, text), app.channel_can(uuid, text),
  app.channel_audience(uuid), app.channel_team_id(uuid), app.channels_join(uuid), app.channels_add_member(uuid, uuid),
  app.channels_remove_member(uuid, uuid), app.channels_sync_template(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.visible_channel_ids(text), app.lookup_channel_can(uuid, text), app.channel_can(uuid, text),
  app.channel_audience(uuid), app.channel_team_id(uuid), app.channels_join(uuid), app.channels_add_member(uuid, uuid),
  app.channels_remove_member(uuid, uuid), app.channels_sync_template(uuid) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.visible_channel_ids(text) OWNER TO manythreads_system;
ALTER FUNCTION app.lookup_channel_can(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.channel_audience(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.channel_team_id(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.channels_guard() OWNER TO manythreads_system;
ALTER FUNCTION app.channels_join(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.channels_add_member(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.channels_remove_member(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.channels_sync_template(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
