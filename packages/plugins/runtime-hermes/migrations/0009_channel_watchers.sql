-- runtime-hermes 0009 (P29): who has a whole channel open, so the folded state of every run in it goes to them. Forward-only: never edit once applied.
--
-- A thread lease (0007) is for an open thread panel: it also asks for the words of the answer (about 12 frames a second per run) and a person may hold only 50. A channel page
-- that draws the task view under its roots needs only the folded state of the runs (`run.activity`, about once a second), for every thread of the channel, with no
-- request per thread. So the page holds ONE lease for the channel, renewed every 20 seconds and held 60 seconds, like the thread's. The run job reads the live rows when it
-- pushes (together with the thread leases), on whichever replica it runs. UNLOGGED: the rows expire by themselves, and nothing is lost if the database restarts.
--
-- A person writes only their own row, in a channel they can read (a bot has none: the route answers 403). The row's trigger caps the live leases a person holds at 8 (each open
-- channel page of each tab is one); the run job asks `channel_audience` when it pushes, so a person who has since lost the channel stops receiving at once.

CREATE UNLOGGED TABLE app.channel_watchers (
  channel_id uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  lease_id   uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (channel_id, person_id, lease_id)
);
CREATE INDEX channel_watchers_person ON app.channel_watchers (person_id);
CREATE INDEX channel_watchers_expiry ON app.channel_watchers (expires_at);
COMMENT ON TABLE app.channel_watchers IS 'rls: person — P: UNLOGGED lease of "this person has this channel open" (renewed every 20 s, held 60 s); a person writes and reads only their own row, in a channel they can read; the run job (system) reads them to choose who gets the folded state of the channel''s runs.';

-- The most live leases one person holds at once (each open channel page of each tab is one).
CREATE FUNCTION app.channel_watchers_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  -- a conversation with a bot is its asker's alone: its runs are never pushed to a channel page
  IF EXISTS (SELECT 1 FROM app.channels c WHERE c.id = NEW.channel_id AND c.kind = 'bot_conversation') THEN
    RAISE EXCEPTION 'a conversation with a bot has no channel lease' USING ERRCODE = 'check_violation';
  END IF;
  -- a renewal (an INSERT that meets its own row) is not a new lease
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM app.channel_watchers w WHERE w.channel_id = NEW.channel_id AND w.person_id = NEW.person_id AND w.lease_id = NEW.lease_id) THEN
    SELECT count(*) INTO v_n FROM app.channel_watchers w WHERE w.person_id = NEW.person_id AND w.expires_at > now();
    IF v_n >= 8 THEN
      RAISE EXCEPTION 'too many open channels' USING ERRCODE = 'check_violation', CONSTRAINT = 'channel_watchers_person_cap';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.channel_watchers_check() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.channel_watchers_check() FROM PUBLIC;
CREATE TRIGGER channel_watchers_check BEFORE INSERT OR UPDATE OF channel_id, person_id ON app.channel_watchers
  FOR EACH ROW EXECUTE FUNCTION app.channel_watchers_check();

ALTER TABLE app.channel_watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_watchers FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_watchers_select ON app.channel_watchers FOR SELECT
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY channel_watchers_insert ON app.channel_watchers FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (person_id = (SELECT app.person_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])));
CREATE POLICY channel_watchers_update ON app.channel_watchers FOR UPDATE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system())
    OR (person_id = (SELECT app.person_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])));
-- A person deletes their own lease (leaving the channel). Expired leases of others are swept by the run job (system).
CREATE POLICY channel_watchers_delete ON app.channel_watchers FOR DELETE USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.channel_watchers TO manythreads_app;

-- The channel read of runs that ended lately (`recent`): the newest first, by channel.
CREATE INDEX run_view_recent_channel ON app.run_view (channel_id, ended_at DESC) WHERE ended_at IS NOT NULL;
