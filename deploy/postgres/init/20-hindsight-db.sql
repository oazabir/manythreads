-- Hindsight (team memory engine, PLAN P5-12) gets its own login role and its own database in the dev Postgres, and can reach nothing else.
-- DEV ONLY: the password below is a development default that lives in this file and in docker-compose.dev.yml; a real deployment (Helm, P10-07)
-- creates the role with a generated secret.
--
-- Idempotent. It runs on the first init of the data volume (docker-entrypoint-initdb.d) and `pnpm memory:up` pipes it into psql again, so a volume
-- that predates it (or has a `hindsight` database owned by the superuser from the first cut of P5-12) is brought to the same state.
--
--  * role `hindsight`: LOGIN, no superuser/createdb/createrole/replication/bypassrls; it owns ONLY the `hindsight` database.
--  * CONNECT on `manythreads` is revoked from PUBLIC, so `hindsight` (the only role that is not a manythreads_* one) cannot even connect to the
--    application database. manythreads_owner owns it and keeps access; manythreads_app and manythreads_system hold an explicit CONNECT grant from
--    the kernel migrations (0001, 0003), which run after this file on a fresh volume and already ran on an old one. Test databases are created
--    fresh and are unaffected.
--  * CONNECT on `hindsight` is revoked from PUBLIC, so no manythreads_* role (app, system) can open Hindsight's database either.
--  * Hindsight's migrations run `CREATE EXTENSION vector` / `pg_trgm`, which a non-superuser may not: they are created here, as the superuser.
SELECT 'CREATE ROLE hindsight LOGIN PASSWORD ''hindsight'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hindsight') \gexec
SELECT 'CREATE DATABASE hindsight OWNER hindsight'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'hindsight') \gexec
ALTER DATABASE hindsight OWNER TO hindsight;
REVOKE ALL ON DATABASE hindsight FROM PUBLIC;
GRANT CONNECT ON DATABASE hindsight TO hindsight;
REVOKE CONNECT ON DATABASE manythreads FROM PUBLIC;
\connect hindsight
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
