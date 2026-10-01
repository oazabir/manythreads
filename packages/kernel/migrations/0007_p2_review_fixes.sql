-- 0007_p2_review_fixes: independent review of 0004-0006. Forward-only: never edit this file once applied.
--
--  1. Owner protection. An admin could rewrite the owner's primary_email, suspend the owner, or attach a verified address
--     to the owner (person_emails), i.e. take the owner's account over through a password reset. workspace_members already
--     says "only an owner touches owner"; people / person_emails / identities now say it too.
--  2. Secrets belong to a workspace. app.secrets had no owner, so an admin of workspace A could link workspace B's secret
--     id to an A provider (the sign-in flow would then use B's client secret against A's endpoints) or delete an orphan
--     secret of B. put_secret now records the caller's workspace; delete_secret only deletes the caller's own; a provider
--     can only reference a secret of its own workspace (a system-created secret without a workspace is system-linkable only).
--  3. Cross-workspace references. Foreign keys only point at a row id, so an admin could write workspace_members,
--     person_emails, identities, role_members or invitations rows that point at a person/team/role/provider of ANOTHER
--     workspace (person_emails: a verified address on a foreign account). One definer guard checks the workspace match.
--  4. A revoked session stays revoked (a person's other live session could clear revoked_at after an admin revoked it).
--  5. A team lead could re-open an accepted invitation or swap its token: accepted_at, token_hash and workspace_id are
--     system-only after the insert.

-- 1. Owner protection ---------------------------------------------------------------------------------------------------
-- May the caller change identity data (email, status, linked sign-ins) of this person? The person themself, the system,
-- an owner, or an admin when the target is not an owner.
CREATE FUNCTION app.may_edit_person(p_person_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT app.is_system()
    OR p_person_id = app.person_id()
    OR app.workspace_role() = 'owner'
    OR NOT EXISTS (SELECT 1 FROM app.workspace_members wm WHERE wm.person_id = p_person_id AND wm.role = 'owner')
$$;
GRANT EXECUTE ON FUNCTION app.may_edit_person(uuid) TO manythreads_app, manythreads_system;

CREATE OR REPLACE FUNCTION app.people_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id THEN
    RAISE EXCEPTION 'a person cannot change id or workspace' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.primary_email IS DISTINCT FROM OLD.primary_email OR NEW.status IS DISTINCT FROM OLD.status) THEN
    IF NOT app.is_workspace_admin() THEN
      RAISE EXCEPTION 'only a workspace admin may change a person''s email or status' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.may_edit_person(OLD.id) THEN
      RAISE EXCEPTION 'only an owner may change an owner''s email or status' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP POLICY person_emails_insert ON app.person_emails;
CREATE POLICY person_emails_insert ON app.person_emails FOR INSERT WITH CHECK (
  app.is_system()
  OR (workspace_id = app.workspace_id() AND app.is_workspace_admin() AND app.may_edit_person(person_id))
  OR (workspace_id = app.workspace_id() AND person_id = app.person_id() AND verified_at IS NULL)
);
DROP POLICY person_emails_update ON app.person_emails;
CREATE POLICY person_emails_update ON app.person_emails FOR UPDATE
  USING (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin() AND app.may_edit_person(person_id)))
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin() AND app.may_edit_person(person_id)));
DROP POLICY person_emails_delete ON app.person_emails;
CREATE POLICY person_emails_delete ON app.person_emails FOR DELETE USING (
  app.is_system() OR person_id = app.person_id()
  OR (workspace_id = app.workspace_id() AND app.is_workspace_admin() AND app.may_edit_person(person_id))
);
DROP POLICY identities_delete ON app.identities;
CREATE POLICY identities_delete ON app.identities FOR DELETE USING (
  app.is_system() OR person_id = app.person_id()
  OR (workspace_id = app.workspace_id() AND app.is_workspace_admin() AND app.may_edit_person(person_id))
);

-- 2. Secrets owned by a workspace ----------------------------------------------------------------------------------------------
ALTER TABLE app.secrets ADD COLUMN workspace_id uuid REFERENCES app.workspaces (id) ON DELETE CASCADE;
CREATE INDEX secrets_workspace ON app.secrets (workspace_id) WHERE workspace_id IS NOT NULL;
COMMENT ON COLUMN app.secrets.workspace_id IS 'Owning workspace (the caller''s at put_secret time); NULL for system-created secrets.';
SET ROLE manythreads_system;
UPDATE app.secrets s SET workspace_id = ap.workspace_id FROM app.auth_providers ap WHERE ap.secret_id = s.id;
RESET ROLE;

CREATE OR REPLACE FUNCTION app.put_secret(p_id uuid, p_ciphertext bytea, p_wrapped_key bytea, p_key_id text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF session_user <> 'manythreads_system' AND coalesce(app.lookup_workspace_role() NOT IN ('owner', 'admin'), true) THEN
    RAISE EXCEPTION 'only a workspace admin may store a secret' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.secrets (id, ciphertext, wrapped_key, key_id, workspace_id)
  VALUES (p_id, p_ciphertext, p_wrapped_key, p_key_id, (SELECT w.id FROM app.workspaces w WHERE w.id = app.workspace_id()));
  RETURN p_id;
END
$$;

CREATE OR REPLACE FUNCTION app.delete_secret(p_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF session_user = 'manythreads_system' THEN
    DELETE FROM app.secrets WHERE id = p_id;
  ELSE
    IF coalesce(app.lookup_workspace_role() NOT IN ('owner', 'admin'), true) THEN
      RAISE EXCEPTION 'only a workspace admin may delete a secret' USING ERRCODE = 'insufficient_privilege';
    END IF;
    DELETE FROM app.secrets WHERE id = p_id AND workspace_id = app.workspace_id();
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;

-- 3. Same-workspace references -------------------------------------------------------------------------------------------------
CREATE FUNCTION app.workspace_refs_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v        jsonb := to_jsonb(NEW);
  ws       uuid := (to_jsonb(NEW) ->> 'workspace_id')::uuid;
  ref      text;
  s_ws     uuid;
  s_found  boolean;
BEGIN
  ref := v ->> 'person_id';
  IF ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.people p WHERE p.id = ref::uuid AND p.workspace_id = ws) THEN
    RAISE EXCEPTION '%.person_id must belong to the row''s workspace', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  ref := v ->> 'team_id';
  IF ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.teams t WHERE t.id = ref::uuid AND t.workspace_id = ws) THEN
    RAISE EXCEPTION '%.team_id must belong to the row''s workspace', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  ref := v ->> 'role_id';
  IF ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.roles r WHERE r.id = ref::uuid AND r.workspace_id = ws) THEN
    RAISE EXCEPTION '%.role_id must belong to the row''s workspace', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  ref := v ->> 'provider_id';
  IF ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.auth_providers ap WHERE ap.id = ref::uuid AND ap.workspace_id = ws) THEN
    RAISE EXCEPTION '%.provider_id must belong to the row''s workspace', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  ref := v ->> 'secret_id';
  IF ref IS NOT NULL THEN
    SELECT true, s.workspace_id INTO s_found, s_ws FROM app.secrets s WHERE s.id = ref::uuid;
    IF s_found IS NOT TRUE
       OR (s_ws IS DISTINCT FROM ws AND NOT (s_ws IS NULL AND session_user = 'manythreads_system')) THEN
      RAISE EXCEPTION '%.secret_id must be a secret of the row''s workspace', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, person_id ON app.workspace_members
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, person_id ON app.person_emails
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, person_id, provider_id ON app.identities
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, person_id, role_id ON app.role_members
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id ON app.invitations
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, secret_id ON app.auth_providers
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- 4. A revoked session stays revoked ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.sessions_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() AND OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked session cannot be reinstated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sessions_guard BEFORE UPDATE ON app.sessions FOR EACH ROW EXECUTE FUNCTION app.sessions_guard();

-- 5. Invitation tokens and acceptance are system-only ---------------------------------------------------------------------------
CREATE FUNCTION app.invitations_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() AND (
       NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
       OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.workspace_id <> OLD.workspace_id) THEN
    RAISE EXCEPTION 'only the system accepts an invitation or changes its token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invitations_guard BEFORE UPDATE ON app.invitations FOR EACH ROW EXECUTE FUNCTION app.invitations_guard();

-- Ownership ------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.workspace_refs_guard() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
