-- 0012_last_lead_guard (P3-00): a team always keeps at least one lead. Forward-only: never edit this file once applied.
--
-- 0009 protects the last workspace owner; nothing protected the last team `lead`. A lead could leave (team_members_delete
-- lets anyone remove themself) or demote the only other lead, and the team was left with nobody who may rename it, manage
-- its roster or invite people (admins still could, but a team without a lead is a mistake, not a state). The guard is a
-- trigger so it holds for every writer: the API, plugins and manual SQL.
--
-- Override: a workspace owner/admin and the system pool may remove or demote the last lead (hand-over, offboarding, repair).
-- The function is SECURITY DEFINER owned by manythreads_system only so it can count the OTHER leads without being filtered
-- by the caller's RLS. Inside it the is_* helpers are always TRUE (current_user is manythreads_system), so the caller is
-- judged by app.lookup_workspace_role() (the person behind app.actor(); NULL for a bot, a suspended person or a stranger) and
-- session_user (the LOGIN role: manythreads_system only for the system pool) as in app.put_secret (MISTAKES: P2 review).
-- A bot lead has no workspace role, so a bot never overrides the guard.
--
-- Concurrency: the other leads' rows are locked FOR UPDATE, so two leads demoting each other at the same moment deadlock
-- (40P01, a 409 "try again" in the teams API) instead of both succeeding.
--
-- A team or workspace that is itself being deleted (ON DELETE CASCADE) is exempt: its row is already gone when the cascade
-- reaches the roster.
-- The roster row counts as a lead even if the person is suspended: suspension is reversible and is the admin's call.

CREATE FUNCTION app.team_last_lead_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_other uuid;
BEGIN
  IF OLD.role <> 'lead' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- An update that leaves this row the lead of the same team changes nothing the guard protects.
  IF TG_OP = 'UPDATE' AND NEW.role = 'lead' AND NEW.team_id = OLD.team_id AND NEW.actor_id = OLD.actor_id THEN
    RETURN NEW;
  END IF;
  IF session_user = 'manythreads_system' OR coalesce(app.lookup_workspace_role() IN ('owner', 'admin'), false) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.teams t WHERE t.id = OLD.team_id)
     OR NOT EXISTS (SELECT 1 FROM app.workspaces w WHERE w.id = OLD.workspace_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT tm.actor_id INTO v_other FROM app.team_members tm
  WHERE tm.team_id = OLD.team_id AND tm.role = 'lead' AND tm.actor_id <> OLD.actor_id
  ORDER BY tm.actor_id
  LIMIT 1
  FOR UPDATE;
  IF v_other IS NULL THEN
    RAISE EXCEPTION 'a team must keep at least one lead; make someone else a lead first'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER team_last_lead_guard BEFORE DELETE OR UPDATE OF role, team_id, actor_id ON app.team_members
  FOR EACH ROW EXECUTE FUNCTION app.team_last_lead_guard();

REVOKE ALL ON FUNCTION app.team_last_lead_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.team_last_lead_guard() TO manythreads_app, manythreads_system;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.team_last_lead_guard() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
