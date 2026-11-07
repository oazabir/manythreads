-- files 0006: "who opened my space" (P20-13). Forward-only: never edit once applied.
--
-- A person may read the opens of their own Personal space (kernel 0016: policy personal_space_access_select), but the admin's name is not theirs
-- to read: the actors table shows a person only their own row. This definer function joins it, for the caller's own space only, and returns
-- nothing else. The caller is checked with lookup_workspace_role() (an owner, admin or member; a guest, a bot or a suspended person has no space).

CREATE FUNCTION app.personal_space_opens(p_limit integer DEFAULT 30, p_before uuid DEFAULT NULL)
  RETURNS TABLE (id uuid, admin_person_id uuid, admin_name text, reason text, opened_at timestamptz, expires_at timestamptz, active boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws     uuid := app.workspace_id();
  v_person uuid := app.person_id();
  v_role   text := app.lookup_workspace_role();
BEGIN
  IF v_ws IS NULL OR v_person IS NULL OR v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'Personal spaces are for members of the workspace' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT psa.id, ap.id, coalesce(ap.display_name, 'Someone'), psa.reason, psa.opened_at, psa.expires_at, psa.expires_at > now()
    FROM app.personal_space_access psa
    LEFT JOIN app.actors a ON a.id = psa.admin_actor_id
    LEFT JOIN app.people ap ON ap.id = a.ref_id AND a.kind = 'person'
   WHERE psa.person_id = v_person AND psa.workspace_id = v_ws
     AND (p_before IS NULL OR psa.id < p_before)
   ORDER BY psa.id DESC
   LIMIT least(greatest(coalesce(p_limit, 30), 1), 101);
END
$$;
REVOKE ALL ON FUNCTION app.personal_space_opens(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personal_space_opens(integer, uuid) TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.personal_space_opens(integer, uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
