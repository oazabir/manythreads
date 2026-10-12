-- Hindsight (team memory engine, PLAN P5-12) keeps its banks in its own database of the dev Postgres, as the LiteLLM proxy does. Runs only on
-- the first init of the data volume (docker-entrypoint-initdb.d); `pnpm memory:up` creates it on an existing volume. Hindsight's migrations
-- need `CREATE EXTENSION vector`, which manythreads_owner may do (it is a superuser in dev compose, like the CNPG owner role).
CREATE DATABASE hindsight;
