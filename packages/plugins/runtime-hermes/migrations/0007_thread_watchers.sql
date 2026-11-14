-- runtime-hermes 0007 (P25-07): who has a thread open, so a run's live steps go to them. Forward-only: never edit once applied.
--
-- A socket cannot say what its page is looking at, and every server replica delivers pushes to its own sockets only. So the open thread panel says it with a lease: it
-- writes one row here when it opens and renews it every 30 seconds; the row says until when it holds (60 seconds). Closing the panel deletes the row. The run job reads
-- the live rows when it pushes, on whichever replica it runs, so there is no per-socket state and no kernel change. UNLOGGED, like `app.typing`: the rows expire by
-- themselves and nothing is lost if the database restarts (the panel renews within 30 seconds).
--
-- A person writes only their own row, in a channel they can read. The run job (system) reads them all.

CREATE UNLOGGED TABLE app.thread_watchers (
  root_id    uuid NOT NULL REFERENCES app.messages (id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (root_id, person_id)
);
CREATE INDEX thread_watchers_person ON app.thread_watchers (person_id);
CREATE INDEX thread_watchers_channel ON app.thread_watchers (channel_id);
COMMENT ON TABLE app.thread_watchers IS 'rls: person — P: UNLOGGED lease of "this person has this thread open" (renewed every 30 s, held 60 s); a person writes and reads only their own row, in a channel they can read; the run job (system) reads them to choose who gets a run''s live steps.';

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
