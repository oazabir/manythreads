-- pages plugin 0002 (PLAN P6-09; SPEC §5.2, §6.4). Forward-only: never edit once applied.
--
--  * page_docs: the CRDT snapshot of one page, folded there when an editing session commits. `last_update_id` is the newest
--    page_updates row the snapshot already contains, so a server that dies mid-session rebuilds from the snapshot plus the
--    updates after it instead of losing the session.
--  * page_updates: every Yjs update, append-only (BRIN on time): the audit of who changed which page, and the replay log.
--  * page_awareness: who is editing where, with an expiry. UNLOGGED: a cursor is worth nothing after a failover, and the
--    table is re-populated by the clients that are still connected.

CREATE TABLE app.page_docs (
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  path           text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 300),
  snapshot       bytea NOT NULL,
  last_update_id bigint NOT NULL DEFAULT 0,
  last_commit_sha text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, path)
);
COMMENT ON TABLE app.page_docs IS 'rls: team — T: the Yjs snapshot of a live page; git stays the truth, this is the session it came from.';

ALTER TABLE app.page_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.page_docs FORCE ROW LEVEL SECURITY;
CREATE POLICY page_docs_select ON app.page_docs FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY page_docs_write ON app.page_docs FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

CREATE TABLE app.page_updates (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id    uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  path       text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 300),
  actor_id   uuid NOT NULL REFERENCES app.actors (id),
  update     bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX page_updates_doc ON app.page_updates (team_id, path, id);
CREATE INDEX page_updates_brin ON app.page_updates USING brin (created_at);
COMMENT ON TABLE app.page_updates IS 'rls: team — T: every Yjs update, append-only; who changed which page and the replay tail after a crash.';

ALTER TABLE app.page_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.page_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY page_updates_select ON app.page_updates FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY page_updates_insert ON app.page_updates FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) AND actor_id = (SELECT app.actor()))
);
CREATE POLICY page_updates_system ON app.page_updates FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

CREATE UNLOGGED TABLE app.page_awareness (
  team_id    uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  path       text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 300),
  actor_id   uuid NOT NULL REFERENCES app.actors (id),
  state      jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (team_id, path, actor_id)
);
CREATE INDEX page_awareness_expiry ON app.page_awareness (expires_at);
COMMENT ON TABLE app.page_awareness IS 'rls: team — T: live cursors (UNLOGGED; a cursor is gone after a failover and the clients send it again).';

ALTER TABLE app.page_awareness ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.page_awareness FORCE ROW LEVEL SECURITY;
CREATE POLICY page_awareness_select ON app.page_awareness FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY page_awareness_write ON app.page_awareness FOR ALL USING (
  (SELECT app.is_system()) OR (team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]) AND actor_id = (SELECT app.actor()))
) WITH CHECK (
  (SELECT app.is_system()) OR (team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]) AND actor_id = (SELECT app.actor()))
);

GRANT SELECT ON app.page_docs TO manythreads_app;
GRANT SELECT, INSERT ON app.page_updates TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.page_awareness TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.page_docs TO manythreads_app;
