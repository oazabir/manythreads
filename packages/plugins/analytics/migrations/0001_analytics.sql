-- analytics 0001: usage numbers, kept as a time series (PLAN P8-11, Appendix A.7, decision D3). Forward-only: never edit once applied.
--
--  * app.analytics_events: one row per thing that happened, counted — a model call's cost, a run that ended, a tool call, an approval, an answer, a
--    knowledge document reached, a sign-in. It is partitioned by month on `occurred_at` (a partition is a smaller table that holds one month of the big
--    one, so a query for one day reads one month's rows, and an old month is dropped from the table in one step). Each partition has the parent's indexes,
--    among them a BRIN (a tiny index over time-ordered rows).
--  * app.analytics_daily: the same rows added up per UTC day, team, bot and metric (and one label such as the model alias), so a page for 30 days reads
--    about thirty rows per series instead of every event. The hourly rollup rewrites the last two days with ON CONFLICT … DO UPDATE.
--  * app.analytics_progress: where the sweeps have got to (system only).
--
-- Content-blind by construction: a row has a metric name, a number and a small object of fixed words (`dims`). The writers never read a message, a file, a
-- title or a secret. The row's person (`actor_id`) is set only on rows that belong to no team (sign-ins), so a team member cannot learn who of their team did
-- what: the CHECK `analytics_events_person_or_team` enforces it.
--
-- Who reads: workspace owners and admins read everything of their workspace (rows with no team included); a team member reads the rows of the teams they can
-- read, except money and model use (metrics starting `llm.`): the spend ledger has always been admin-only, and this table must not widen that. A guest
-- reads nothing (`readable_team_ids` is empty for a guest). Only the system role writes.
--
-- Partitions are made by app.analytics_ensure_month(), called before every write and by the daily `analytics.partitions` job, and detached (never dropped) by
-- app.analytics_detach_before(). Both are SECURITY DEFINER functions owned by the migrating role, because making or detaching a partition needs to own the
-- parent table; EXECUTE is granted to the system role alone, and the only input is a date. The migration makes the current month and the next two.

-- analytics_events (T / W) -------------------------------------------------------------------------------------------------
CREATE TABLE app.analytics_events (
  id           uuid NOT NULL DEFAULT uuidv7(),
  occurred_at  timestamptz NOT NULL,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- no foreign keys on team, actor or bot: a number outlives the team or bot it counted
  team_id      uuid,
  actor_id     uuid,
  bot_id       uuid,
  metric       text NOT NULL CHECK (metric ~ '^[a-z_]+(\.[a-z_]+){1,2}$' AND char_length(metric) <= 60),
  value        double precision NOT NULL CHECK (value > '-Infinity'::float8 AND value < 'Infinity'::float8),
  dims         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(dims) = 'object' AND pg_column_size(dims) <= 1000),
  PRIMARY KEY (id, occurred_at),
  CONSTRAINT analytics_events_person_or_team CHECK (team_id IS NULL OR actor_id IS NULL)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX analytics_events_brin ON app.analytics_events USING brin (occurred_at);
CREATE INDEX analytics_events_workspace_metric ON app.analytics_events (workspace_id, metric, occurred_at);
CREATE INDEX analytics_events_team_metric ON app.analytics_events (team_id, metric, occurred_at) WHERE team_id IS NOT NULL;
CREATE INDEX analytics_events_bot_metric ON app.analytics_events (bot_id, metric, occurred_at) WHERE bot_id IS NOT NULL;
CREATE INDEX analytics_events_dims ON app.analytics_events USING gin (dims jsonb_path_ops);
COMMENT ON TABLE app.analytics_events IS 'rls: team — T: a counted thing (cost, run, tool call, approval, answer, knowledge hit, sign-in) per row, monthly partitions; workspace owners and admins read the workspace, a team member reads the rows of their teams except money (metric llm.%), a guest nothing; only the system role writes, and no role changes a row.';

-- analytics_daily (T / W) --------------------------------------------------------------------------------------------------
CREATE TABLE app.analytics_daily (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  day          date NOT NULL,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid,
  bot_id       uuid,
  metric       text NOT NULL CHECK (metric ~ '^[a-z_]+(\.[a-z_]+){1,2}$' AND char_length(metric) <= 60),
  -- the one label the rollup keeps apart for this metric (shared ANALYTICS_METRIC_LABEL); '' when the metric has none
  dim          text NOT NULL DEFAULT '' CHECK (char_length(dim) <= 80),
  total        double precision NOT NULL,
  n            bigint NOT NULL CHECK (n >= 0)
);
-- A.7 puts the day, workspace, metric, team and bot in the primary key. A key cannot hold NULL, and a row without a team or a bot is common, so the same
-- columns (plus the label) are one unique index that treats NULLs as equal; the rollup's ON CONFLICT names it.
CREATE UNIQUE INDEX analytics_daily_key ON app.analytics_daily (workspace_id, day, metric, dim, team_id, bot_id) NULLS NOT DISTINCT;
CREATE INDEX analytics_daily_team ON app.analytics_daily (team_id, day) WHERE team_id IS NOT NULL;
CREATE INDEX analytics_daily_bot ON app.analytics_daily (bot_id, day) WHERE bot_id IS NOT NULL;
COMMENT ON TABLE app.analytics_daily IS 'rls: team — T: analytics_events added up per UTC day, team, bot, metric and one label; same reading rule as the events; only the system role writes.';

-- analytics_progress (S) ---------------------------------------------------------------------------------------------------
CREATE TABLE app.analytics_progress (
  name       text PRIMARY KEY CHECK (name ~ '^[a-z_]{1,60}$'),
  value      text NOT NULL CHECK (char_length(value) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.analytics_progress IS 'rls: system — S: where the analytics sweeps have got to (how far each source table has been read, the last day rolled up); no privilege for manythreads_app.';

-- Row level security -------------------------------------------------------------------------------------------------------
ALTER TABLE app.analytics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.analytics_events FORCE ROW LEVEL SECURITY;
CREATE POLICY analytics_events_select ON app.analytics_events FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (
        (SELECT app.workspace_role()) IN ('owner', 'admin')
        OR (team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]) AND metric NOT LIKE 'llm.%')))
);
CREATE POLICY analytics_events_insert ON app.analytics_events FOR INSERT WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.analytics_events TO manythreads_app;
-- append-only for the system role too (a partition goes away by being detached, not by deleting its rows)
REVOKE UPDATE, DELETE, TRUNCATE ON app.analytics_events FROM manythreads_system;

ALTER TABLE app.analytics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.analytics_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY analytics_daily_select ON app.analytics_daily FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (
        (SELECT app.workspace_role()) IN ('owner', 'admin')
        OR (team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]) AND metric NOT LIKE 'llm.%')))
);
CREATE POLICY analytics_daily_system ON app.analytics_daily FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.analytics_daily TO manythreads_app;

ALTER TABLE app.analytics_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.analytics_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY analytics_progress_system ON app.analytics_progress FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- Partitions ---------------------------------------------------------------------------------------------------------------
-- Make sure the partition for the month of `p_month` is attached; answer whether a row of that month can be written. `p_oldest` is the first month the
-- deployment keeps (older rows are not written: their month would be detached again at once). A month more than three months ahead is refused too: a
-- clock gone wrong must not make partitions for years.
CREATE FUNCTION app.analytics_ensure_month(p_month date, p_oldest date) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_first   date := date_trunc('month', p_month)::date;
  v_now     date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  v_oldest  date := date_trunc('month', p_oldest)::date;
  v_name    text := 'analytics_events_' || to_char(date_trunc('month', p_month)::date, 'YYYY_MM');
BEGIN
  IF p_month IS NULL OR p_oldest IS NULL THEN
    RETURN false;
  END IF;
  IF v_first < v_oldest OR v_first > (v_now + interval '3 months')::date THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'app.analytics_events'::regclass AND c.relname = v_name
  ) THEN
    RETURN true;
  END IF;
  -- two writers meeting the same new month: the second waits here, then finds the partition made
  PERFORM pg_advisory_xact_lock(hashtext('analytics:partitions'));
  IF EXISTS (
    SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'app.analytics_events'::regclass AND c.relname = v_name
  ) THEN
    RETURN true;
  END IF;
  EXECUTE format(
    'CREATE TABLE app.%I PARTITION OF app.analytics_events FOR VALUES FROM (%L) TO (%L)',
    v_name,
    to_char(v_first, 'YYYY-MM-DD') || ' 00:00:00+00',
    to_char((v_first + interval '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00'
  );
  -- Reading a partition directly is not how the table is used: the app role has no privilege on it, and the system role may only read it.
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', v_name);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', v_name);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()))', v_name || '_system', v_name);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, manythreads_app', v_name);
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON app.%I FROM manythreads_system', v_name);
  EXECUTE format('COMMENT ON TABLE app.%I IS %L', v_name, 'rls: system — S: one month of analytics_events; reached through the parent table, never directly.');
  RETURN true;
END
$$;

-- Detach the partitions whose whole month ends on or before `p_before` and answer their names. A detached month is an ordinary table that keeps its rows (an
-- operator exports and drops it); it is renamed so its month can never clash with a new partition, and locked down like a partition.
CREATE FUNCTION app.analytics_detach_before(p_before date) RETURNS text[]
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_part   record;
  v_month  date;
  v_new    text;
  v_done   text[] := '{}';
BEGIN
  IF p_before IS NULL THEN
    RETURN v_done;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('analytics:partitions'));
  FOR v_part IN
    SELECT c.relname AS name
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'app.analytics_events'::regclass AND c.relname ~ '^analytics_events_[0-9]{4}_[0-9]{2}$'
     ORDER BY c.relname
  LOOP
    v_month := to_date(substr(v_part.name, 18, 7), 'YYYY_MM');
    IF (v_month + interval '1 month')::date <= p_before THEN
      v_new := v_part.name || '_detached_' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS');
      EXECUTE format('ALTER TABLE app.analytics_events DETACH PARTITION app.%I', v_part.name);
      EXECUTE format('ALTER TABLE app.%I RENAME TO %I', v_part.name, v_new);
      EXECUTE format('COMMENT ON TABLE app.%I IS %L', v_new, 'rls: system — S: a month of analytics_events detached from the table; kept until an operator exports and drops it.');
      v_done := v_done || v_new;
    END IF;
  END LOOP;
  RETURN v_done;
END
$$;

REVOKE ALL ON FUNCTION app.analytics_ensure_month(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.analytics_detach_before(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.analytics_ensure_month(date, date) TO manythreads_system;
GRANT EXECUTE ON FUNCTION app.analytics_detach_before(date) TO manythreads_system;
COMMENT ON FUNCTION app.analytics_ensure_month(date, date) IS 'Attach the monthly partition of analytics_events for a month in the kept window and answer whether it exists; SECURITY DEFINER because only the table owner may make a partition; system role only.';
COMMENT ON FUNCTION app.analytics_detach_before(date) IS 'Detach (not drop) every analytics_events partition whose month ended on or before the date and answer the new names; system role only.';

-- the current month and the next two, so a fresh install writes at once and a one-day query has its partition
SELECT app.analytics_ensure_month(m::date, (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date)
  FROM generate_series(date_trunc('month', now() AT TIME ZONE 'UTC'), date_trunc('month', now() AT TIME ZONE 'UTC') + interval '2 months', interval '1 month') AS m;
