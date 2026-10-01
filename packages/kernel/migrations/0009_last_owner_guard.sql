-- 0009_last_owner_guard: a workspace always keeps at least one owner. Forward-only: never edit this file once applied.
--
-- Nothing stopped the last owner from being demoted or removed: workspace_members_update/delete let an owner touch an
-- owner row, so the only person who may grant `owner` could lock the workspace out of its own settings (admins cannot
-- create or restore an owner, see the 0004 policies). The guard is a trigger so it holds for every writer: the API,
-- plugins, the system pool and manual SQL.
--
-- The function is SECURITY DEFINER owned by manythreads_system only so it can count the OTHER owners without being filtered
-- by the caller's RLS. It grants nothing and answers nothing about the caller, so it needs no caller check (MISTAKES: the
-- is_* helpers are always TRUE inside a definer owned by manythreads_system, which is why none is used here). It only ever
-- refuses.
--
-- Concurrency: the other owners' rows are locked FOR UPDATE, so two owners demoting each other at the same moment
-- deadlock (40P01) instead of both succeeding; the survivor still finds the winner's row as an owner.
--
-- A workspace that is itself being deleted (ON DELETE CASCADE from app.workspaces) is exempt: its row is already gone when the
-- cascade reaches the members.

CREATE FUNCTION app.workspace_owner_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_other uuid;
BEGIN
  IF OLD.role <> 'owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- An update that leaves this row an owner of the same workspace changes nothing the guard protects.
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' AND NEW.workspace_id = OLD.workspace_id AND NEW.person_id = OLD.person_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.workspaces w WHERE w.id = OLD.workspace_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT wm.person_id INTO v_other FROM app.workspace_members wm
  WHERE wm.workspace_id = OLD.workspace_id AND wm.role = 'owner' AND wm.person_id <> OLD.person_id
  ORDER BY wm.person_id
  LIMIT 1
  FOR UPDATE;
  IF v_other IS NULL THEN
    RAISE EXCEPTION 'a workspace must keep at least one owner; make someone else an owner first'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER workspace_owner_guard BEFORE DELETE OR UPDATE OF role, person_id, workspace_id ON app.workspace_members
  FOR EACH ROW EXECUTE FUNCTION app.workspace_owner_guard();

REVOKE ALL ON FUNCTION app.workspace_owner_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspace_owner_guard() TO manythreads_app, manythreads_system;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.workspace_owner_guard() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
