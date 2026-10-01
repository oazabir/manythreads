-- 0003_system_role: the system actor becomes a real Postgres role (P1-04b security hardening).
--
-- PROBLEM. app.is_system() used to read the session setting app.actor_kind, which any SQL running in the
-- transaction can change with set_config(); code holding a raw query handle could make itself the system actor and
-- bypass every RLS policy.
--
-- DESIGN.
--  * Role manythreads_system (LOGIN, NOBYPASSRLS, NOSUPERUSER) is the only identity that is "system". The kernel's
--    withSystem() runs on a pool that logs in as it. app.is_system() is `current_user = 'manythreads_system'`: a name
--    comparison, not membership, so a superuser owner in dev gets no implicit system powers. manythreads_app is not a
--    member of manythreads_system and cannot SET ROLE to it; the GUC app.actor_kind no longer grants anything.
--  * is_system() is SECURITY INVOKER on purpose: inside a SECURITY DEFINER function current_user is the function
--    owner, so a definer helper can never be mistaken for the system actor. The four helpers that wrap it
--    (is_workspace_admin, is_team_member, team_role, can) are therefore invoker functions too. Phase 2 must keep
--    that shape: `app.is_system() OR <membership lookup>` where only the lookup is a definer function.
--  * Narrow SECURITY DEFINER functions owned by manythreads_system (app.enqueue_outbox, app.enqueue_job,
--    app.upsert_job_schedule) let a person/bot transaction write the system-only tables without ever becoming
--    system: they do fixed logic, no dynamic SQL, and the caller's session is unchanged afterwards.
--
-- TRUST MODEL. app.actor(), app.workspace_id(), app.run_id() still read GUCs set by withActor. In-process kernel
-- code is trusted to set them; code that can run arbitrary SQL in a transaction (plugins) can still spoof a
-- person/bot identity until plugins get their own database role. The SDK PluginTx rejects set_config/SET/RESET
-- as a stopgap (docs/plugins/security.md). The system escalation is closed for real.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'manythreads_system') THEN
    CREATE ROLE manythreads_system LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

ALTER ROLE manythreads_system NOBYPASSRLS NOSUPERUSER;

DO $$
BEGIN
  -- manythreads_app must never be able to become manythreads_system.
  IF pg_has_role('manythreads_app', 'manythreads_system', 'member') THEN
    REVOKE manythreads_system FROM manythreads_app;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO manythreads_system', current_database());
  EXECUTE format('ALTER ROLE manythreads_system IN DATABASE %I SET search_path = app, public', current_database());
END
$$;

-- The owner must be a member to hand function ownership to manythreads_system (below).
GRANT manythreads_system TO manythreads_owner;

GRANT USAGE ON SCHEMA app TO manythreads_system;

-- Privileges: everything the app role has, plus the same on tables created later by migrations (plugins); the
-- event log stays append-only for the system role too.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO manythreads_system;
ALTER DEFAULT PRIVILEGES FOR ROLE manythreads_owner IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO manythreads_system;
REVOKE UPDATE, DELETE, TRUNCATE ON app.events FROM manythreads_system;
REVOKE INSERT, UPDATE, DELETE ON app.schema_migrations, app.global_tables FROM manythreads_system;

-- The check ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_system() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
  AS $$ SELECT current_user = 'manythreads_system' $$;

CREATE OR REPLACE FUNCTION app.is_workspace_admin() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT app.is_system() $$;

CREATE OR REPLACE FUNCTION app.is_team_member(team_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT app.is_system() $$;

CREATE OR REPLACE FUNCTION app.team_role(team_id uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT CASE WHEN app.is_system() THEN 'system' END $$;

CREATE OR REPLACE FUNCTION app.can(resource_type text, resource_id uuid, permission text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT app.is_system() $$;

-- app.actor_kind() stays for diagnostics only; nothing may base a decision on it.
COMMENT ON FUNCTION app.actor_kind() IS 'Diagnostic only: the GUC is caller-controlled and grants nothing. Use app.is_system().';

-- Definer helpers ---------------------------------------------------------------------------------------------
-- app.enqueue_outbox no longer sets app.actor_kind; ownership by manythreads_system is what lets it write the outbox.
CREATE OR REPLACE FUNCTION app.enqueue_outbox(p_event_id uuid) RETURNS SETOF text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  sub text;
BEGIN
  FOR sub IN
    WITH ev AS (
      SELECT id, type FROM app.events WHERE id = p_event_id AND actor_id = app.actor()
    ), ins AS (
      INSERT INTO app.outbox (event_id, subscriber)
      SELECT DISTINCT ev.id, s.subscriber
      FROM ev JOIN app.event_subscriptions s ON s.event_type = ev.type OR s.event_type = '*'
      ON CONFLICT (event_id, subscriber) DO NOTHING
      RETURNING subscriber
    )
    SELECT subscriber FROM ins
  LOOP
    PERFORM pg_notify('manythreads_outbox', sub);
    RETURN NEXT sub;
  END LOOP;
END
$$;

-- Get-or-create on the dedupe index (DO SELECT, Postgres 19) so a hit writes nothing; NOTIFY goes out at commit.
CREATE FUNCTION app.enqueue_job(p_queue text, p_payload jsonb, p_run_at timestamptz, p_dedupe_key text)
  RETURNS app.jobs
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  j app.jobs;
BEGIN
  IF p_dedupe_key IS NULL THEN
    INSERT INTO app.jobs (queue, payload, run_at)
    VALUES (p_queue, coalesce(p_payload, '{}'::jsonb), coalesce(p_run_at, now()))
    RETURNING * INTO j;
  ELSE
    INSERT INTO app.jobs (queue, payload, run_at, dedupe_key)
    VALUES (p_queue, coalesce(p_payload, '{}'::jsonb), coalesce(p_run_at, now()), p_dedupe_key)
    ON CONFLICT (queue, dedupe_key) WHERE state IN ('ready', 'running') DO SELECT
    RETURNING * INTO j;
  END IF;
  PERFORM pg_notify('manythreads_jobs', p_queue);
  RETURN j;
END
$$;

CREATE FUNCTION app.upsert_job_schedule(p_name text, p_cron_expr text, p_queue text, p_payload jsonb)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
  INSERT INTO app.job_schedules (name, cron_expr, queue, payload)
  VALUES (p_name, p_cron_expr, p_queue, coalesce(p_payload, '{}'::jsonb))
  ON CONFLICT (name) DO UPDATE SET cron_expr = EXCLUDED.cron_expr, queue = EXCLUDED.queue,
    payload = EXCLUDED.payload, enabled = true
$$;

REVOKE ALL ON FUNCTION app.enqueue_job(text, jsonb, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.upsert_job_schedule(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enqueue_job(text, jsonb, timestamptz, text) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.upsert_job_schedule(text, text, text, jsonb) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.enqueue_outbox(uuid) TO manythreads_system;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO manythreads_system;

-- Hand the definer functions to manythreads_system (ALTER ... OWNER needs CREATE on the schema for the new owner;
-- granted only for this statement block).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.enqueue_outbox(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.enqueue_job(text, jsonb, timestamptz, text) OWNER TO manythreads_system;
ALTER FUNCTION app.upsert_job_schedule(text, text, text, jsonb) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
