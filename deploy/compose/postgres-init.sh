#!/bin/sh
# Runs once, when the data volume of the Postgres container is first made (docker-entrypoint-initdb.d). It makes what the other containers need that the
# application's own migrations do not: the `litellm` database for the model gateway, and the `hindsight` login role and database for team memory.
# The same state as deploy/postgres/init/*.sql, with the Hindsight password taken from the environment instead of written in the file.
#
# The roles manythreads_app and manythreads_system are made by the application's first migration, with MANYTHREADS_APP_PASSWORD and
# MANYTHREADS_SYSTEM_PASSWORD, so they are not made here.
set -eu
: "${HINDSIGHT_DB_PASSWORD:?HINDSIGHT_DB_PASSWORD is not set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v hspw="$HINDSIGHT_DB_PASSWORD" <<'SQL'
SELECT 'CREATE DATABASE litellm' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'litellm') \gexec

SELECT format('CREATE ROLE hindsight LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'hspw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hindsight') \gexec
SELECT 'CREATE DATABASE hindsight OWNER hindsight'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'hindsight') \gexec
ALTER DATABASE hindsight OWNER TO hindsight;
REVOKE ALL ON DATABASE hindsight FROM PUBLIC;
GRANT CONNECT ON DATABASE hindsight TO hindsight;
-- hindsight (the only login role that is not a manythreads_* one) cannot open the application database; manythreads_app and manythreads_system get an
-- explicit CONNECT from the application's migrations.
REVOKE CONNECT ON DATABASE manythreads FROM PUBLIC;
\connect hindsight
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
