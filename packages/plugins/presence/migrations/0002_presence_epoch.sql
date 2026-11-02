-- presence 0002: when the heartbeat data started (PLAN.md P14-09). Forward-only: never edit once applied.
--
-- `app.presence` (channels 0003) is UNLOGGED: a database crash empties it, and until the open tabs have sent their next heartbeat (every 30 seconds)
-- everybody looks "away". A job that acts on absence (the email digest) must not send in that gap. This one-row table is UNLOGGED too, so it is lost
-- in the very same crash: the first `warmSince` after that makes it again with the time of now, and the job waits a few minutes from there.

CREATE UNLOGGED TABLE app.presence_epoch (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  started_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.presence_epoch IS 'rls: system — S: UNLOGGED single row, the time the heartbeat data was last empty and started again; only the system role (the email digest job, through the presence provider) reads or writes it.';
ALTER TABLE app.presence_epoch ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.presence_epoch FORCE ROW LEVEL SECURITY;
CREATE POLICY presence_epoch_system ON app.presence_epoch FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
