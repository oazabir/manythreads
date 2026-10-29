-- notifications 0003: how loud each channel is for a person, their keywords, and browser push (PLAN.md P14-09). Forward-only: never edit once applied.
--
--  * notifications.kind gains `message` (any message of a channel the person asked to hear everything from) and `keyword` records the person's
--    own word that turned a message into a mention. Both are written by the consumer (system), like every other column.
--  * notification_levels: a person's own level (all, mentions, nothing) for one channel. No row means "follow the default". A person may set
--    one only for a channel they can read (the policy probes the hoisted visibility set); the row goes with the channel or the person.
--  * notification_workspace_settings: the level every team channel starts with, per workspace. Every member of the workspace reads it, only a
--    workspace owner or admin writes it. No row means `mentions`.
--  * notification_keywords: a person's words, stored lower case with single spaces; `first_word` narrows the consumer's lookup (one indexed
--    equality per word of a message) before the whole phrase is checked.
--  * push_subscriptions: the browsers a person signed up for push. The endpoint is unique across the table, so signing in as someone else in
--    the same browser moves the subscription instead of leaving the earlier person's alerts arriving there; the move is a narrow definer
--    function (a person cannot see or change another person's row).

ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'reply', 'dm', 'message'));
ALTER TABLE app.notifications ADD COLUMN keyword text CHECK (keyword IS NULL OR length(keyword) BETWEEN 1 AND 80);

CREATE TABLE app.notification_levels (
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  level        text NOT NULL CHECK (level IN ('all', 'mentions', 'nothing')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, channel_id)
);
CREATE INDEX notification_levels_channel ON app.notification_levels (channel_id);
CREATE INDEX notification_levels_workspace ON app.notification_levels (workspace_id);
COMMENT ON TABLE app.notification_levels IS 'rls: person — P: a person''s own notification level for a channel they can read; the consumer (system) reads them to decide who is told.';

CREATE TABLE app.notification_workspace_settings (
  workspace_id  uuid PRIMARY KEY REFERENCES app.workspaces (id) ON DELETE CASCADE,
  default_level text NOT NULL DEFAULT 'mentions' CHECK (default_level IN ('all', 'mentions', 'nothing')),
  updated_by    uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_workspace_settings_updated_by ON app.notification_workspace_settings (updated_by) WHERE updated_by IS NOT NULL;
COMMENT ON TABLE app.notification_workspace_settings IS 'rls: workspace — W: the level team channels start with; members read it, workspace owners and admins write it.';

CREATE TABLE app.notification_keywords (
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  keyword      text NOT NULL CHECK (length(keyword) BETWEEN 1 AND 80),
  first_word   text NOT NULL CHECK (length(first_word) BETWEEN 1 AND 80),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, keyword)
);
CREATE INDEX notification_keywords_first_word ON app.notification_keywords (first_word);
CREATE INDEX notification_keywords_workspace ON app.notification_keywords (workspace_id);
COMMENT ON TABLE app.notification_keywords IS 'rls: person — P: a person''s own keywords (whole words, any case) that count as a mention; the consumer (system) reads them to match new messages.';

CREATE TABLE app.push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  endpoint     text NOT NULL CHECK (length(endpoint) BETWEEN 12 AND 2048),
  p256dh       text NOT NULL CHECK (length(p256dh) BETWEEN 40 AND 200),
  auth         text NOT NULL CHECK (length(auth) BETWEEN 10 AND 100),
  label        text NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  failures     integer NOT NULL DEFAULT 0 CHECK (failures >= 0)
);
CREATE UNIQUE INDEX push_subscriptions_endpoint ON app.push_subscriptions (endpoint);
CREATE INDEX push_subscriptions_person ON app.push_subscriptions (person_id);
CREATE INDEX push_subscriptions_workspace ON app.push_subscriptions (workspace_id);
COMMENT ON TABLE app.push_subscriptions IS 'rls: person — P: the browsers a person signed up for push; a person reads and removes only their own, and signs a browser up through app.notifications_push_subscribe.';

ALTER TABLE app.notification_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_levels FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_levels_select ON app.notification_levels FOR SELECT
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY notification_levels_insert ON app.notification_levels FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())
      AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])));
CREATE POLICY notification_levels_update ON app.notification_levels FOR UPDATE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system())
    OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())
        AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])));
CREATE POLICY notification_levels_delete ON app.notification_levels FOR DELETE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));

ALTER TABLE app.notification_workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_workspace_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_workspace_settings_select ON app.notification_workspace_settings FOR SELECT
  USING ((SELECT app.is_system()) OR workspace_id = (SELECT app.workspace_id()));
CREATE POLICY notification_workspace_settings_insert ON app.notification_workspace_settings FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY notification_workspace_settings_update ON app.notification_workspace_settings FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));

ALTER TABLE app.notification_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_keywords FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_keywords_select ON app.notification_keywords FOR SELECT
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY notification_keywords_insert ON app.notification_keywords FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY notification_keywords_delete ON app.notification_keywords FOR DELETE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));

ALTER TABLE app.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_subscriptions FORCE ROW LEVEL SECURITY;
-- The system role reads every row (to send) and updates or deletes them (a send result, a browser the push service says is gone).
CREATE POLICY push_subscriptions_system ON app.push_subscriptions FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY push_subscriptions_select ON app.push_subscriptions FOR SELECT
  USING (person_id = (SELECT app.person_id()));
CREATE POLICY push_subscriptions_delete ON app.push_subscriptions FOR DELETE
  USING (person_id = (SELECT app.person_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON app.notification_levels TO manythreads_app;
GRANT SELECT, INSERT, UPDATE ON app.notification_workspace_settings TO manythreads_app;
GRANT SELECT, INSERT, DELETE ON app.notification_keywords TO manythreads_app;
GRANT SELECT, DELETE ON app.push_subscriptions TO manythreads_app;

-- Signs the caller's browser up for push. If the same browser (endpoint) belonged to someone else, it moves to the caller: one browser has one
-- person at a time. Answers how many browsers the caller now has. The caller must be a person of a workspace.
CREATE FUNCTION app.notifications_push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_label text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_person    uuid := app.person_id();
  v_workspace uuid := app.workspace_id();
  v_count     integer;
BEGIN
  IF v_person IS NULL OR v_workspace IS NULL THEN
    RAISE EXCEPTION 'push belongs to people' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.push_subscriptions (workspace_id, person_id, endpoint, p256dh, auth, label)
  VALUES (v_workspace, v_person, p_endpoint, p_p256dh, p_auth, left(coalesce(p_label, ''), 80))
  ON CONFLICT (endpoint) DO UPDATE
    SET workspace_id = EXCLUDED.workspace_id, person_id = EXCLUDED.person_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
        label = EXCLUDED.label, failures = 0;
  SELECT count(*)::integer INTO v_count FROM app.push_subscriptions WHERE person_id = v_person;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION app.notifications_push_subscribe(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notifications_push_subscribe(text, text, text, text) TO manythreads_app, manythreads_system;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.notifications_push_subscribe(text, text, text, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
