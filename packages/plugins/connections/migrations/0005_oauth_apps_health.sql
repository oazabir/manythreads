-- connections 0005: the OAuth apps a workspace admin enters, and the health of a person's sign-in (PLAN P16-02). Forward-only: never edit once applied.
--
-- A self-hosted company signs people in to Google and Microsoft with its OWN apps, not one that ships with the software. Until now the app's id and secret came from the
-- server's environment; this adds the place an admin puts them instead:
--
--   connection_oauth_apps         one row per workspace and provider: the app's client id (not a secret: it is in every consent address), the Microsoft tenant, who
--                                 set it and when. Readable by workspace admins; written by the system only (the route checks the admin).
--   connection_oauth_app_secrets  the app's client SECRET, a pointer to an envelope-encrypted row of app.secrets (the platform's own sealing). System only: no privilege
--                                 for manythreads_app, never returned by any route. A row that goes (cleared, or the workspace deleted) takes its sealed value with it.
--
-- And on connection_oauth, what the platform knows about whether a person's sign-in is still alive:
--
--   failures       renewals that failed in a row since the last one that worked (the provider was down, or refused for a reason other than "no longer valid")
--   last_problem   what the last failure was, in one word; null after a renewal worked
--   notified_at    when the person was told to reconnect; null until then and again after they reconnect, so one expired sign-in is one notice

CREATE TABLE app.connection_oauth_apps (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- the app's public id: shown to admins so they can tell which app is in use; the secret is in connection_oauth_app_secrets
  client_id    text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 500),
  -- Microsoft only: the directory to sign people in to (`common`, `organizations`, an id or a domain); null = the server's default
  tenant       text CHECK (tenant IS NULL OR char_length(tenant) BETWEEN 1 AND 64),
  updated_by   uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider)
);
CREATE INDEX connection_oauth_apps_updated_by ON app.connection_oauth_apps (updated_by);
COMMENT ON TABLE app.connection_oauth_apps IS 'rls: workspace — T: the OAuth app (client id, tenant) a workspace admin entered for a provider; readable by workspace admins, written by the system only. The secret is in connection_oauth_app_secrets.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id ON app.connection_oauth_apps
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

CREATE TABLE app.connection_oauth_app_secrets (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  provider     text NOT NULL,
  -- the sealed client secret; the plaintext is never stored here and never read back by a route
  secret_id    uuid NOT NULL REFERENCES app.secrets (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider),
  FOREIGN KEY (workspace_id, provider) REFERENCES app.connection_oauth_apps (workspace_id, provider) ON DELETE CASCADE
);
CREATE INDEX connection_oauth_app_secrets_secret ON app.connection_oauth_app_secrets (secret_id);
COMMENT ON TABLE app.connection_oauth_app_secrets IS 'rls: system — S: reference to the sealed client secret of a workspace''s OAuth app (app.secrets); no privilege for manythreads_app, never returned by any API.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, secret_id ON app.connection_oauth_app_secrets
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- The sealed value goes with the row that pointed at it (cleared by an admin, or cascaded away with the app or the workspace). Same shape as connection_secrets_reap.
CREATE FUNCTION app.connection_oauth_app_secrets_reap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  DELETE FROM app.secrets s WHERE s.id = OLD.secret_id AND NOT EXISTS (SELECT 1 FROM app.connection_oauth_app_secrets o WHERE o.secret_id = OLD.secret_id);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.connection_oauth_app_secrets_reap() FROM PUBLIC;
CREATE TRIGGER connection_oauth_app_secrets_reap AFTER DELETE ON app.connection_oauth_app_secrets
  FOR EACH ROW EXECUTE FUNCTION app.connection_oauth_app_secrets_reap();

ALTER TABLE app.connection_oauth ADD COLUMN failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0);
ALTER TABLE app.connection_oauth ADD COLUMN last_problem text CHECK (last_problem IS NULL OR last_problem IN ('unavailable', 'rejected'));
ALTER TABLE app.connection_oauth ADD COLUMN notified_at timestamptz;
-- the renewal job's list: connections still alive whose access token is about to end
CREATE INDEX connection_oauth_renewal ON app.connection_oauth (access_expires_at) WHERE state = 'ok' AND access_expires_at IS NOT NULL;

-- Row level security ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.connection_oauth_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_oauth_apps FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_oauth_apps_select ON app.connection_oauth_apps FOR SELECT USING (
  (SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin'))
);
CREATE POLICY connection_oauth_apps_insert ON app.connection_oauth_apps FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY connection_oauth_apps_update ON app.connection_oauth_apps FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY connection_oauth_apps_delete ON app.connection_oauth_apps FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.connection_oauth_apps TO manythreads_app;

ALTER TABLE app.connection_oauth_app_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_oauth_app_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_oauth_app_secrets_system ON app.connection_oauth_app_secrets FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: a person's session cannot even name the table

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.connection_oauth_app_secrets_reap() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
