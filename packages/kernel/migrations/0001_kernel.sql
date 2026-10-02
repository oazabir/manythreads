-- 0001_kernel: extensions, roles, schema `app`, RLS helpers and the Appendix A.1 kernel tables.
-- Forward-only: never edit this file once applied (the runner checks its sha256).
-- Everything is schema-qualified; the runner does not set a search_path.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- Roles are cluster-wide. manythreads_owner owns the objects and runs migrations (a superuser in dev, where it
-- already exists); manythreads_app runs the server and can never bypass RLS. The runner sets manythreads_app's password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'manythreads_owner') THEN
    CREATE ROLE manythreads_owner LOGIN CREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'manythreads_app') THEN
    CREATE ROLE manythreads_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

ALTER ROLE manythreads_app NOBYPASSRLS NOSUPERUSER;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO manythreads_app', current_database());
  EXECUTE format('ALTER ROLE manythreads_app IN DATABASE %I SET search_path = app, public', current_database());
END
$$;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO manythreads_app;

-- G · global tables ----------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.schema_migrations (
  id         text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.schema_migrations IS 'GLOBAL (G): applied migration files; not workspace data, no RLS.';

-- The RLS harness (pnpm test:rls) requires every other table in schema app to have forced RLS and a policy.
CREATE TABLE app.global_tables (
  name text PRIMARY KEY
);
COMMENT ON TABLE app.global_tables IS 'GLOBAL (G): allowlist of tables exempt from RLS. Adding a row needs a migration comment saying why.';
INSERT INTO app.global_tables (name) VALUES ('schema_migrations'), ('plugins'), ('global_tables');

-- Session context ------------------------------------------------------------------------------------------
-- withActor sets these with set_config(..., true) (SET LOCAL). Outside a transaction they read as ''/NULL.
-- app.actor_kind is a fourth setting beside the three in Appendix A.0: is_system() needs the kind without
-- reading app.actors (which is itself under RLS).
CREATE FUNCTION app.actor() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid $$;

CREATE FUNCTION app.workspace_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE FUNCTION app.run_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT NULLIF(current_setting('app.run_id', true), '')::uuid $$;

CREATE FUNCTION app.actor_kind() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT NULLIF(current_setting('app.actor_kind', true), '') $$;

CREATE FUNCTION app.is_system() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT coalesce(NULLIF(current_setting('app.actor_kind', true), '') = 'system', false) $$;

-- Phase 2 replaces these four with real membership lookups (CREATE OR REPLACE FUNCTION). Until then only the
-- system actor passes, so every non-system read of a team-scoped table returns zero rows (safe default).
CREATE FUNCTION app.is_workspace_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT app.is_system() $$;

CREATE FUNCTION app.is_team_member(team_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT app.is_system() $$;

CREATE FUNCTION app.team_role(team_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT CASE WHEN app.is_system() THEN 'system' END $$;

CREATE FUNCTION app.can(resource_type text, resource_id uuid, permission text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT app.is_system() $$;

-- actors ---------------------------------------------------------------------------------------------------
CREATE TABLE app.actors (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  kind         text NOT NULL CHECK (kind IN ('person', 'bot', 'system')),
  workspace_id uuid NOT NULL,
  ref_id       uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, ref_id)
);

-- The calling actor's own row is always readable; everything else, and every write, is system only.
CREATE FUNCTION app.person_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT ref_id FROM app.actors WHERE id = app.actor() AND kind = 'person' $$;

ALTER TABLE app.actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.actors FORCE ROW LEVEL SECURITY;
CREATE POLICY actors_select ON app.actors FOR SELECT USING (app.is_system() OR id = app.actor());
CREATE POLICY actors_insert ON app.actors FOR INSERT WITH CHECK (app.is_system());
CREATE POLICY actors_update ON app.actors FOR UPDATE USING (app.is_system()) WITH CHECK (app.is_system());
CREATE POLICY actors_delete ON app.actors FOR DELETE USING (app.is_system());

-- events (append-only; doubles as the audit log until phase 10) ----------------------------------------------
CREATE TABLE app.events (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  workspace_id   uuid NOT NULL,
  team_id        uuid,
  actor_id       uuid NOT NULL,
  type           text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_occurred_at_brin ON app.events USING brin (occurred_at);
CREATE INDEX events_workspace_type_id ON app.events (workspace_id, type, id DESC);
CREATE INDEX events_team_id_id ON app.events (team_id, id DESC) WHERE team_id IS NOT NULL;

ALTER TABLE app.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.events FORCE ROW LEVEL SECURITY;
-- T: team rows by team membership. Workspace-level rows (team_id NULL) by workspace admin until phase 2 adds
-- workspace membership. Writers may append rows for their own workspace as themselves; nobody updates or deletes.
CREATE POLICY events_select ON app.events FOR SELECT USING (
  app.is_system()
  OR (team_id IS NOT NULL AND app.is_team_member(team_id))
  OR (team_id IS NULL AND workspace_id = app.workspace_id() AND app.is_workspace_admin())
);
CREATE POLICY events_insert ON app.events FOR INSERT WITH CHECK (
  app.is_system() OR (workspace_id = app.workspace_id() AND actor_id = app.actor())
);

-- outbox ---------------------------------------------------------------------------------------------------
CREATE TABLE app.outbox (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id     uuid NOT NULL REFERENCES app.events (id),
  subscriber   text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  done_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON app.outbox (subscriber, available_at) WHERE done_at IS NULL;
CREATE INDEX outbox_event_id ON app.outbox (event_id);

ALTER TABLE app.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_system ON app.outbox FOR ALL USING (app.is_system()) WITH CHECK (app.is_system());

-- jobs -----------------------------------------------------------------------------------------------------
CREATE TABLE app.jobs (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  queue      text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at     timestamptz NOT NULL DEFAULT now(),
  state      text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'running', 'done', 'failed', 'dead')),
  attempts   integer NOT NULL DEFAULT 0,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON app.jobs (queue, run_at) WHERE state = 'ready';
CREATE UNIQUE INDEX jobs_dedupe ON app.jobs (queue, dedupe_key) WHERE state IN ('ready', 'running');

ALTER TABLE app.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_system ON app.jobs FOR ALL USING (app.is_system()) WITH CHECK (app.is_system());

-- job_leases (UNLOGGED: empty after a crash; the reaper returns the orphaned jobs to ready) -------------------
CREATE UNLOGGED TABLE app.job_leases (
  job_id     uuid PRIMARY KEY REFERENCES app.jobs (id) ON DELETE CASCADE,
  worker_id  text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_leases_expires_at ON app.job_leases (expires_at);

ALTER TABLE app.job_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.job_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY job_leases_system ON app.job_leases FOR ALL USING (app.is_system()) WITH CHECK (app.is_system());

-- scoped_kv (plugin scoped storage: team -> T, person -> P, workspace -> WR) -----------------------------------
CREATE TABLE app.scoped_kv (
  plugin     text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('workspace', 'team', 'person')),
  scope_id   uuid NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin, scope_type, scope_id, key)
);

ALTER TABLE app.scoped_kv ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scoped_kv FORCE ROW LEVEL SECURITY;
-- Workspace scope: any actor of that workspace reads (workspace actors are members until guests arrive in
-- phase 2), only admins write. Team scope: team members. Person scope: that person only.
CREATE POLICY scoped_kv_select ON app.scoped_kv FOR SELECT USING (
  app.is_system()
  OR (scope_type = 'team' AND app.is_team_member(scope_id))
  OR (scope_type = 'person' AND scope_id = app.person_id())
  OR (scope_type = 'workspace' AND scope_id = app.workspace_id())
);
CREATE POLICY scoped_kv_insert ON app.scoped_kv FOR INSERT WITH CHECK (
  app.is_system()
  OR (scope_type = 'team' AND app.is_team_member(scope_id))
  OR (scope_type = 'person' AND scope_id = app.person_id())
  OR (scope_type = 'workspace' AND scope_id = app.workspace_id() AND app.is_workspace_admin())
);
CREATE POLICY scoped_kv_update ON app.scoped_kv FOR UPDATE USING (
  app.is_system()
  OR (scope_type = 'team' AND app.is_team_member(scope_id))
  OR (scope_type = 'person' AND scope_id = app.person_id())
  OR (scope_type = 'workspace' AND scope_id = app.workspace_id() AND app.is_workspace_admin())
) WITH CHECK (
  app.is_system()
  OR (scope_type = 'team' AND app.is_team_member(scope_id))
  OR (scope_type = 'person' AND scope_id = app.person_id())
  OR (scope_type = 'workspace' AND scope_id = app.workspace_id() AND app.is_workspace_admin())
);
CREATE POLICY scoped_kv_delete ON app.scoped_kv FOR DELETE USING (
  app.is_system()
  OR (scope_type = 'team' AND app.is_team_member(scope_id))
  OR (scope_type = 'person' AND scope_id = app.person_id())
  OR (scope_type = 'workspace' AND scope_id = app.workspace_id() AND app.is_workspace_admin())
);

-- entity_links (T) -------------------------------------------------------------------------------------------
CREATE TABLE app.entity_links (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  team_id    uuid NOT NULL,
  src_type   text NOT NULL,
  src_id     uuid NOT NULL,
  dst_type   text NOT NULL,
  dst_id     uuid NOT NULL,
  kind       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (src_type, src_id, dst_type, dst_id, kind)
);
CREATE INDEX entity_links_dst ON app.entity_links (dst_type, dst_id);
CREATE INDEX entity_links_team ON app.entity_links (team_id);

ALTER TABLE app.entity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.entity_links FORCE ROW LEVEL SECURITY;
CREATE POLICY entity_links_team ON app.entity_links FOR ALL
  USING (app.is_team_member(team_id) OR app.is_system())
  WITH CHECK (app.is_team_member(team_id) OR app.is_system());

-- plugins (G) --------------------------------------------------------------------------------------------------
CREATE TABLE app.plugins (
  name       text PRIMARY KEY,
  version    text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  manifest   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.plugins IS 'GLOBAL (G): loaded plugin versions, one row per plugin for the whole install; no RLS.';

-- capability_grants (T read, S write) ----------------------------------------------------------------------------
CREATE TABLE app.capability_grants (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  team_id        uuid NOT NULL,
  actor_id       uuid NOT NULL REFERENCES app.actors (id),
  capability     text NOT NULL,
  needs_approval boolean NOT NULL DEFAULT false,
  constraints    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, capability)
);
CREATE INDEX capability_grants_team ON app.capability_grants (team_id);

ALTER TABLE app.capability_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.capability_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_grants_select ON app.capability_grants FOR SELECT
  USING (app.is_team_member(team_id) OR app.is_system());
CREATE POLICY capability_grants_insert ON app.capability_grants FOR INSERT WITH CHECK (app.is_system());
CREATE POLICY capability_grants_update ON app.capability_grants FOR UPDATE
  USING (app.is_system()) WITH CHECK (app.is_system());
CREATE POLICY capability_grants_delete ON app.capability_grants FOR DELETE USING (app.is_system());

-- Privileges for manythreads_app (least privilege; plugin migrations grant their own tables) ------------------------
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO manythreads_app;
GRANT SELECT ON app.schema_migrations, app.global_tables TO manythreads_app;
GRANT SELECT, INSERT ON app.actors TO manythreads_app;
GRANT SELECT, INSERT ON app.events TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.outbox, app.jobs, app.job_leases TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.scoped_kv, app.capability_grants TO manythreads_app;
GRANT SELECT, INSERT, DELETE ON app.entity_links TO manythreads_app;
GRANT SELECT, INSERT, UPDATE ON app.plugins TO manythreads_app;

-- Acceptance criterion 8: the event log is append-only for the application role.
REVOKE UPDATE, DELETE, TRUNCATE ON app.events FROM manythreads_app;
