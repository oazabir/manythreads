-- runtime-hermes 0007 (P25-07): who has a thread open, so a run's live steps go to them. Forward-only: never edit once applied.
--
-- A socket cannot say what its page is looking at, and every server replica delivers pushes to its own sockets only. So the open thread panel says it with a lease: it
-- writes one row here when it opens and renews it every 20 seconds; the row says until when it holds (60 seconds). Closing the panel deletes the row. The run job reads
-- the live rows when it pushes, on whichever replica it runs, so there is no per-socket state and no kernel change. UNLOGGED, like `app.typing`: the rows expire by
-- themselves and nothing is lost if the database restarts (the panel renews within 20 seconds).
--
-- A person writes only their own row, in a channel they can read. The run job (system) reads them all.
--
-- A lease belongs to one open panel, not to the person: each browser tab names its own `lease_id`, so a tab that closes ends its own lease and never the one another
-- tab of the same person still holds. A trigger keeps the row honest (its channel is the channel of its root message, the root is a thread root) and caps the leases a
-- person holds at once; the run job also asks `channel_audience` when it pushes, so a person who has since lost the channel stops receiving at once.

CREATE UNLOGGED TABLE app.thread_watchers (
  root_id    uuid NOT NULL REFERENCES app.messages (id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  lease_id   uuid NOT NULL,
  channel_id uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (root_id, person_id, lease_id)
);
CREATE INDEX thread_watchers_person ON app.thread_watchers (person_id);
CREATE INDEX thread_watchers_channel ON app.thread_watchers (channel_id);
CREATE INDEX thread_watchers_expiry ON app.thread_watchers (expires_at);
COMMENT ON TABLE app.thread_watchers IS 'rls: person — P: UNLOGGED lease of "this person has this thread open" (renewed every 20 s, held 60 s); a person writes and reads only their own row, in a channel they can read; the run job (system) reads them to choose who gets a run''s live steps.';

-- The most leases one person holds at once (each open thread panel of each tab is one).
CREATE FUNCTION app.thread_watchers_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  -- the root is a thread root of this very channel (messages are read as the definer's role, so a root the caller cannot read is checked too)
  IF NOT EXISTS (SELECT 1 FROM app.messages m WHERE m.id = NEW.root_id AND m.channel_id = NEW.channel_id AND m.thread_root_id IS NULL) THEN
    RAISE EXCEPTION 'a lease names the channel of its thread root' USING ERRCODE = 'check_violation';
  END IF;
  -- a renewal (an INSERT that meets its own row) is not a new lease
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM app.thread_watchers w WHERE w.root_id = NEW.root_id AND w.person_id = NEW.person_id AND w.lease_id = NEW.lease_id) THEN
    SELECT count(*) INTO v_n FROM app.thread_watchers w WHERE w.person_id = NEW.person_id AND w.expires_at > now();
    IF v_n >= 50 THEN
      RAISE EXCEPTION 'too many open threads' USING ERRCODE = 'check_violation', CONSTRAINT = 'thread_watchers_person_cap';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.thread_watchers_check() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.thread_watchers_check() FROM PUBLIC;
CREATE TRIGGER thread_watchers_check BEFORE INSERT OR UPDATE OF root_id, channel_id, person_id ON app.thread_watchers
  FOR EACH ROW EXECUTE FUNCTION app.thread_watchers_check();

ALTER TABLE app.thread_watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.thread_watchers FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_watchers_select ON app.thread_watchers FOR SELECT
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY thread_watchers_insert ON app.thread_watchers FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (person_id = (SELECT app.person_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])));
CREATE POLICY thread_watchers_update ON app.thread_watchers FOR UPDATE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system())
    OR (person_id = (SELECT app.person_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])));
-- A person deletes their own lease (closing the panel). Expired leases of others are swept by the run job (system).
CREATE POLICY thread_watchers_delete ON app.thread_watchers FOR DELETE USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.thread_watchers TO manythreads_app;
