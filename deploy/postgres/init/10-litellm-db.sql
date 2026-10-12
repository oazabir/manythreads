-- The LiteLLM proxy keeps its virtual keys in its own database; the dev stack reuses this Postgres (PLAN P5-06). Runs only
-- on the first init of the data volume (docker-entrypoint-initdb.d). A cluster that already has a volume needs the database
-- created by hand: `psql -h localhost -p 55432 -U manythreads_owner -c 'CREATE DATABASE litellm'`.
CREATE DATABASE litellm;
