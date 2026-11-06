-- 0016_spaces (P20-01): the space model. A space is where a kept thing belongs: one person's Personal space, or a team's.
-- Forward-only: never edit this file once applied.
--
-- WHAT THIS ADDS
--   app.readable_space_ids(permission)  the ids of every space the caller may read/post in: the caller's own person id, plus the
--                                       teams of app.readable_team_ids(permission), plus (for 'read' only, and only for a workspace
--                                       owner/admin) the person ids whose Personal space the caller has a LIVE audited open on.
--   app.personal_space_access           one row per admin "open" of someone's Personal space: who, whose, why (reason text lives
--                                       ONLY here, never in the event log or the audit trail), when, and when it lapses (60 minutes).
--   app.open_personal_space(person, reason)  the only door that writes that table (security definer; checks the caller).
--   app.people.suspended_at             when a person was deactivated (NULL while active). Derived from `status` by a trigger, so it
--                                       cannot disagree with it; the 30-day deletion clock of a leaver starts here.
--
-- THE ONE ACCESS-RULE SHAPE (every table that holds space data uses exactly this; docs/engineering/conventions.md "Visibility sets")
--   columns   team_id uuid NULL REFERENCES app.teams, owner_person_id uuid NULL REFERENCES app.people,
--             CHECK (num_nonnulls(team_id, owner_person_id) = 1)         -- exactly one owner (files: a channel file has neither, exempt)
--   read      (SELECT app.is_system())
--             OR owner_person_id = ANY ((SELECT app.readable_space_ids('read'))::uuid[])
--             OR team_id         = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
--   insert    (SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND
--               (owner_person_id = (SELECT app.person_id()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])))
--   update / delete   the same test on the row (USING) and on the new row (WITH CHECK): Personal rows by their owner only,
--             team rows by 'post' (never 'write' for members: that name is not a permission, and 'manage' is leads only).
--   A table never asks "is this an admin?" for Personal data: an admin reaches a Personal row only through a live
--   personal_space_access row, and only for reading (the 'post'/'manage' sets never include another person), so the open is
--   read-only by the database, not by the screen. Hoisted sets only: no per-row function call (findPerRowPolicyCalls).
--
-- Inside the definer functions below app.is_system()/is_workspace_admin() are TRUE (current_user is manythreads_system), so the
-- caller is checked with app.lookup_workspace_role() and the actors row (MISTAKES: P2 review, P5-20).

-- people.suspended_at ----------------------------------------------------------------------------------------------------------
-- Nullable, no default: a default would stamp history with the instant of the migration (MISTAKES P5-13).
ALTER TABLE app.people ADD COLUMN suspended_at timestamptz;

-- Backfill as the system role: the migration role is subject to the forced row security of people (MISTAKES P5-13).
SET ROLE manythreads_system;
UPDATE app.people SET suspended_at = updated_at WHERE status = 'suspended';
RESET ROLE;

-- suspended_at follows status: set once when a person becomes suspended, kept while they stay suspended, cleared on reactivation.
CREATE FUNCTION app.people_suspended_at() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.status = 'suspended' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'suspended' AND OLD.suspended_at IS NOT NULL THEN
      NEW.suspended_at := OLD.suspended_at;
    ELSE
      NEW.suspended_at := now();
    END IF;
  ELSE
    NEW.suspended_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER people_suspended_at BEFORE INSERT OR UPDATE ON app.people FOR EACH ROW EXECUTE FUNCTION app.people_suspended_at();

-- personal_space_access --------------------------------------------------------------------------------------------------------
CREATE TABLE app.personal_space_access (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  person_id      uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  admin_actor_id uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  reason         text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  CHECK (expires_at > opened_at)
);
CREATE INDEX personal_space_access_person ON app.personal_space_access (person_id, opened_at DESC);
CREATE INDEX personal_space_access_admin ON app.personal_space_access (admin_actor_id, expires_at DESC);
CREATE INDEX personal_space_access_workspace ON app.personal_space_access (workspace_id);
COMMENT ON TABLE app.personal_space_access IS 'rls: person — P: a person reads the opens of their own Personal space (who, why, when); an admin reads the opens they made; rows are written only by app.open_personal_space (and the system role).';

ALTER TABLE app.personal_space_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.personal_space_access FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_space_access_select ON app.personal_space_access FOR SELECT USING (
  (SELECT app.is_system())
  OR person_id = (SELECT app.person_id())
  OR admin_actor_id = (SELECT app.actor())
);
CREATE POLICY personal_space_access_insert ON app.personal_space_access FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY personal_space_access_update ON app.personal_space_access FOR UPDATE
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY personal_space_access_delete ON app.personal_space_access FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.personal_space_access TO manythreads_app;

-- readable_space_ids -----------------------------------------------------------------------------------------------------------
-- A suspended person, a system or unknown actor, an unknown permission: the empty array. A bot: its teams only (a bot has no Personal
-- space of its own; what it may read of a person is decided by the gateway from the run, never here). A guest: their own person id only.
CREATE FUNCTION app.readable_space_ids(p_permission text DEFAULT 'read') RETURNS uuid[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws      uuid := app.workspace_id();
  v_actor   uuid := app.actor();
  v_kind    text;
  v_ref     uuid;
  v_ws_role text;
  v_teams   uuid[];
  v_opened  uuid[];
BEGIN
  IF app.permission_rank(p_permission) IS NULL OR v_ws IS NULL OR v_actor IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  SELECT a.kind, a.ref_id INTO v_kind, v_ref FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
  IF v_kind IS NULL OR v_kind = 'system' THEN
    RETURN '{}'::uuid[];
  END IF;
  v_teams := app.readable_team_ids(p_permission);
  IF v_kind <> 'person' THEN
    RETURN v_teams;
  END IF;
  v_ws_role := app.lookup_workspace_role();
  IF v_ws_role IS NULL THEN
    RETURN '{}'::uuid[];   -- suspended or without membership
  END IF;
  v_opened := '{}'::uuid[];
  IF p_permission = 'read' AND v_ws_role IN ('owner', 'admin') THEN
    SELECT coalesce(array_agg(DISTINCT psa.person_id), '{}'::uuid[]) INTO v_opened
    FROM app.personal_space_access psa
    WHERE psa.admin_actor_id = v_actor AND psa.workspace_id = v_ws AND psa.expires_at > now() AND psa.person_id <> v_ref;
  END IF;
  RETURN v_ref || v_teams || v_opened;
END
$$;

-- open_personal_space ----------------------------------------------------------------------------------------------------------
-- An owner or admin opens one person's Personal space for 60 minutes, with a reason the person can later read. Refused: a non-admin,
-- a suspended admin, a person of another workspace (or none), one's own space, an empty or over-long reason. Each call is a new row,
-- so every open is its own line in the person's list. The caller's actor id is read here, never passed in.
CREATE FUNCTION app.open_personal_space(p_person uuid, p_reason text) RETURNS TABLE (access_id uuid, valid_until timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws      uuid := app.workspace_id();
  v_actor   uuid := app.actor();
  v_kind    text;
  v_ref     uuid;
  v_role    text;
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_id      uuid;
  v_until   timestamptz;
BEGIN
  IF v_ws IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'only a workspace owner or admin may open a Personal space' USING ERRCODE = '42501';
  END IF;
  SELECT a.kind, a.ref_id INTO v_kind, v_ref FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
  v_role := CASE WHEN v_kind = 'person' THEN app.lookup_workspace_role() END;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'only a workspace owner or admin may open a Personal space' USING ERRCODE = '42501';
  END IF;
  IF p_person IS NULL OR NOT EXISTS (SELECT 1 FROM app.people p WHERE p.id = p_person AND p.workspace_id = v_ws) THEN
    RAISE EXCEPTION 'no such person in this workspace' USING ERRCODE = '23503';
  END IF;
  IF p_person = v_ref THEN
    RAISE EXCEPTION 'you cannot open your own Personal space' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'give a reason of 1 to 300 characters' USING ERRCODE = '22023';
  END IF;
  v_until := now() + interval '60 minutes';
  INSERT INTO app.personal_space_access (workspace_id, person_id, admin_actor_id, reason, opened_at, expires_at)
  VALUES (v_ws, p_person, v_actor, v_reason, now(), v_until)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, v_until;
END
$$;

REVOKE ALL ON FUNCTION app.readable_space_ids(text), app.open_personal_space(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.readable_space_ids(text), app.open_personal_space(uuid, text) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.readable_space_ids(text) OWNER TO manythreads_system;
ALTER FUNCTION app.open_personal_space(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
