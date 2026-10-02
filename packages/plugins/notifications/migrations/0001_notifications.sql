-- notifications 0001: notifications and notification_prefs (PLAN.md A.3, P3-09). Forward-only: never edit once applied.
--
-- WHO WRITES. Nobody a person can reach: notifications are made by the plugin's event consumer, which runs as the system role
-- (`channel.mention.created`, `channel.message.posted`). A person reads their own inbox and marks items read; that is all the app role is
-- granted (SELECT, UPDATE) and a trigger limits the update to `read_at` going from null to a time.
--
-- WHO READS. The person the row is for, and only while they can still read the channel it came from: the SELECT policy probes the hoisted
-- visibility set of channels 0001 (`channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])`, once per statement), so a person
-- removed from a private channel loses its previews with their access. The plugin `dependsOn` channels for this.
--
-- ONE ROW PER MESSAGE AND PERSON. (person_id, ref_type, ref_id) is unique, and the consumer upserts: a message that is both a reply in a
-- thread you follow and names you is one notification of the stronger kind (mention > reply > dm), whichever event arrives first, and a
-- redelivered event changes nothing.

CREATE TABLE app.notifications (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL,
  person_id      uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('mention', 'reply', 'dm')),
  ref_type       text NOT NULL CHECK (ref_type IN ('message')),
  ref_id         uuid NOT NULL,
  channel_id     uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  thread_root_id uuid,
  actor_id       uuid NOT NULL,
  actor_name     text NOT NULL CHECK (length(actor_name) BETWEEN 1 AND 200),
  preview        text NOT NULL CHECK (length(preview) <= 280),
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_person_ref ON app.notifications (person_id, ref_type, ref_id);
CREATE INDEX notifications_person_id_desc ON app.notifications (person_id, id DESC);
CREATE INDEX notifications_unread ON app.notifications (person_id, id DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_ref ON app.notifications (ref_type, ref_id);
CREATE INDEX notifications_channel ON app.notifications (channel_id);
CREATE INDEX notifications_created_brin ON app.notifications USING brin (created_at);
COMMENT ON TABLE app.notifications IS 'rls: person — P: a person reads their own notifications of channels they can still read and marks them read; rows are written by the plugin''s consumer (system).';

CREATE TABLE app.notification_prefs (
  person_id    uuid PRIMARY KEY REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  prefs        jsonb NOT NULL CHECK (jsonb_typeof(prefs) = 'object'),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.notification_prefs IS 'rls: person — P: a person reads and writes only their own settings; the consumer (system) reads them.';

-- A notification changes only by being read, and stays read.
CREATE FUNCTION app.notifications_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    IF (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN
      RAISE EXCEPTION 'a notification changes only by being read' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
      RAISE EXCEPTION 'a read notification stays read' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notifications_guard BEFORE UPDATE ON app.notifications FOR EACH ROW EXECUTE FUNCTION app.notifications_guard();

-- Row level security -----------------------------------------------------------------------------------------------------------
ALTER TABLE app.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notifications FORCE ROW LEVEL SECURITY;
-- The consumer (system) writes and deletes; the system role is not BYPASSRLS, so it needs a policy of its own.
CREATE POLICY notifications_system ON app.notifications FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY notifications_select_own ON app.notifications FOR SELECT
  USING (person_id = (SELECT app.person_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY notifications_update_own ON app.notifications FOR UPDATE
  USING (person_id = (SELECT app.person_id())) WITH CHECK (person_id = (SELECT app.person_id()));

ALTER TABLE app.notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_prefs_select ON app.notification_prefs FOR SELECT
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY notification_prefs_insert ON app.notification_prefs FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY notification_prefs_update ON app.notification_prefs FOR UPDATE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system()) OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())));

GRANT SELECT, UPDATE ON app.notifications TO manythreads_app;
GRANT SELECT, INSERT, UPDATE ON app.notification_prefs TO manythreads_app;
