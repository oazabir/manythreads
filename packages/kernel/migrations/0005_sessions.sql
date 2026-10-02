-- 0005_sessions: PLAN.md A.2 credential and session tables: password_credentials, sessions, session_cache (UNLOGGED),
-- invitations, email_verifications. Forward-only: never edit this file once applied.
-- The sign-in flows run before any actor exists, so they use the system pool; everything a person may touch about
-- their own sessions is policy-limited below. manythreads_app has no privilege at all on the S tables.

-- password_credentials (S) -----------------------------------------------------------------------------------------------
CREATE TABLE app.password_credentials (
  person_id   uuid PRIMARY KEY REFERENCES app.people (id) ON DELETE CASCADE,
  hash        text NOT NULL CHECK (hash LIKE '$argon2id$%'),
  must_change boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.password_credentials IS 'rls: system — S: argon2id hashes; no privilege for manythreads_app, never returned by any API.';

-- sessions (P; W) ------------------------------------------------------------------------------------------------------------
CREATE TABLE app.sessions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  device       text,
  revoked_at   timestamptz
);
CREATE INDEX sessions_person_live ON app.sessions (person_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_workspace ON app.sessions (workspace_id);
CREATE INDEX sessions_created_brin ON app.sessions USING brin (created_at);
COMMENT ON TABLE app.sessions IS 'rls: person — P: own sessions (read, revoke); W: admins; creating and touching sessions is system.';

-- session_cache (S, UNLOGGED) --------------------------------------------------------------------------------------------------
CREATE UNLOGGED TABLE app.session_cache (
  token_hash bytea PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES app.sessions (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_cache_session ON app.session_cache (session_id);
COMMENT ON TABLE app.session_cache IS 'rls: system — S: UNLOGGED token-hash lookups, rebuilt from sessions after a crash.';

-- invitations (W; team leads) -------------------------------------------------------------------------------------------------
-- team_id gets its foreign key in 0006 (teams do not exist yet). A guest invitation never carries a team.
CREATE TABLE app.invitations (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid,
  email        text NOT NULL CHECK (email <> ''),
  role         text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  grant_spec   jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_hash   bytea NOT NULL,
  invited_by   uuid REFERENCES app.people (id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'guest' OR team_id IS NULL)
);
CREATE UNIQUE INDEX invitations_token_open ON app.invitations (token_hash) WHERE accepted_at IS NULL;
CREATE INDEX invitations_workspace ON app.invitations (workspace_id);
CREATE INDEX invitations_team ON app.invitations (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX invitations_invited_by ON app.invitations (invited_by) WHERE invited_by IS NOT NULL;
COMMENT ON TABLE app.invitations IS 'rls: workspace — W: admins; team leads for their own team (role member only); acceptance is system.';

-- email_verifications (S) -----------------------------------------------------------------------------------------------------
CREATE TABLE app.email_verifications (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  email        text,
  token_hash   bytea NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_verifications_token ON app.email_verifications (token_hash);
CREATE INDEX email_verifications_person ON app.email_verifications (person_id);
CREATE INDEX email_verifications_workspace ON app.email_verifications (workspace_id);
COMMENT ON TABLE app.email_verifications IS 'rls: system — S: verify and reset links (hashes only); no privilege for manythreads_app.';

-- Row level security -------------------------------------------------------------------------------------------------------------
ALTER TABLE app.password_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.password_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY password_credentials_system ON app.password_credentials FOR ALL
  USING (app.is_system()) WITH CHECK (app.is_system());

ALTER TABLE app.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_select ON app.sessions FOR SELECT USING (
  app.is_system() OR person_id = app.person_id() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin())
);
CREATE POLICY sessions_insert ON app.sessions FOR INSERT WITH CHECK (app.is_system());
-- Column grants below limit non-system updates to revoked_at.
CREATE POLICY sessions_update ON app.sessions FOR UPDATE
  USING (app.is_system() OR person_id = app.person_id() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()))
  WITH CHECK (app.is_system() OR person_id = app.person_id() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));
CREATE POLICY sessions_delete ON app.sessions FOR DELETE USING (
  app.is_system() OR person_id = app.person_id() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin())
);

ALTER TABLE app.session_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.session_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY session_cache_system ON app.session_cache FOR ALL USING (app.is_system()) WITH CHECK (app.is_system());

-- app.team_role() is the 0003 placeholder until 0006 replaces it in place (CREATE OR REPLACE keeps this policy's function).
ALTER TABLE app.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_select ON app.invitations FOR SELECT USING (
  app.is_system()
  OR (workspace_id = app.workspace_id()
      AND (app.is_workspace_admin() OR (team_id IS NOT NULL AND app.team_role(team_id) = 'lead')))
);
CREATE POLICY invitations_insert ON app.invitations FOR INSERT WITH CHECK (
  app.is_system()
  OR (workspace_id = app.workspace_id()
      AND (app.is_workspace_admin() OR (team_id IS NOT NULL AND role = 'member' AND app.team_role(team_id) = 'lead')))
);
CREATE POLICY invitations_update ON app.invitations FOR UPDATE
  USING (
    app.is_system()
    OR (workspace_id = app.workspace_id()
        AND (app.is_workspace_admin() OR (team_id IS NOT NULL AND app.team_role(team_id) = 'lead')))
  )
  WITH CHECK (
    app.is_system()
    OR (workspace_id = app.workspace_id()
        AND (app.is_workspace_admin() OR (team_id IS NOT NULL AND role = 'member' AND app.team_role(team_id) = 'lead')))
  );
CREATE POLICY invitations_delete ON app.invitations FOR DELETE USING (
  app.is_system()
  OR (workspace_id = app.workspace_id()
      AND (app.is_workspace_admin() OR (team_id IS NOT NULL AND app.team_role(team_id) = 'lead')))
);

ALTER TABLE app.email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.email_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY email_verifications_system ON app.email_verifications FOR ALL
  USING (app.is_system()) WITH CHECK (app.is_system());

-- Privileges -----------------------------------------------------------------------------------------------------------------------
GRANT SELECT, DELETE ON app.sessions TO manythreads_app;
GRANT UPDATE (revoked_at) ON app.sessions TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.invitations TO manythreads_app;
REVOKE ALL ON app.password_credentials, app.session_cache, app.email_verifications FROM PUBLIC, manythreads_app;
