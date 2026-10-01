-- 0002_events_outbox_jobs: P1-05 / P1-06 runtime support for emit, the outbox consumers and the job queue.
--
-- DESIGN CHOICE (outbox RLS). `outbox` stays system-only (0001). A caller's withActor transaction cannot insert
-- into it, so `emit` calls the SECURITY DEFINER function app.enqueue_outbox(event_id) after inserting the event.
-- The function carries `SET app.actor_kind = 'system'` (a function-level setting: restored when it returns, so
-- the caller is never elevated beyond the call) and fans out to every row of app.event_subscriptions matching the
-- event type. It only accepts events the caller itself wrote (events.actor_id = app.actor()), so it cannot be
-- used to re-deliver somebody else's events; (event_id, subscriber) is unique so a repeat call is a no-op.
-- app.event_subscriptions is system-only (RLS, not a global table): subscriptions are kernel configuration
-- registered at startup through withSystem. NOTIFY is issued inside the function; it is delivered at commit.

ALTER TABLE app.outbox
  ADD COLUMN claimed_until timestamptz,   -- lease of the consumer holding the row; expiry makes it claimable again
  ADD COLUMN dead_at       timestamptz,   -- dead letter: attempts exhausted
  ADD COLUMN last_error    text;
CREATE UNIQUE INDEX outbox_event_subscriber ON app.outbox (event_id, subscriber);
DROP INDEX app.outbox_pending;
CREATE INDEX outbox_pending ON app.outbox (subscriber, available_at) WHERE done_at IS NULL AND dead_at IS NULL;

-- Exactly-once effects for consumers that need them: the handler inserts here in the same transaction as its effect.
CREATE TABLE app.outbox_processed (
  subscriber   text NOT NULL,
  event_id     uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscriber, event_id)
);
ALTER TABLE app.outbox_processed ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_processed FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_processed_system ON app.outbox_processed FOR ALL USING (app.is_system()) WITH CHECK (app.is_system());

CREATE TABLE app.event_subscriptions (
  subscriber text NOT NULL,
  event_type text NOT NULL,   -- exact type, or '*' for every event
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscriber, event_type)
);
ALTER TABLE app.event_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.event_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY event_subscriptions_system ON app.event_subscriptions FOR ALL
  USING (app.is_system()) WITH CHECK (app.is_system());

CREATE FUNCTION app.enqueue_outbox(p_event_id uuid) RETURNS SETOF text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
  SET app.actor_kind = 'system'
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
    PERFORM pg_notify('majlis_outbox', sub);
    RETURN NEXT sub;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION app.enqueue_outbox(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enqueue_outbox(uuid) TO majlis_app;

-- jobs --------------------------------------------------------------------------------------------------------
ALTER TABLE app.jobs
  ADD COLUMN last_error  text,
  ADD COLUMN finished_at timestamptz;
CREATE INDEX jobs_running ON app.jobs (queue) WHERE state = 'running';

-- Cron schedules; the ticker enqueues one job per (schedule, slot) and remembers the last slot it handled.
CREATE TABLE app.job_schedules (
  name       text PRIMARY KEY,
  cron_expr  text NOT NULL,
  queue      text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled    boolean NOT NULL DEFAULT true,
  last_slot  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.job_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.job_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY job_schedules_system ON app.job_schedules FOR ALL USING (app.is_system()) WITH CHECK (app.is_system());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.outbox_processed, app.event_subscriptions, app.job_schedules TO majlis_app;
