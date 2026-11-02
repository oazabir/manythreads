-- notifications 0005: the email digest (PLAN.md P14-09). Forward-only: never edit once applied.
--
-- After a person has been away for a while, one mail lists the mentions, replies and direct messages they have not read. This table holds, per
-- person: whether they want it, how long away before it is sent, the time of the latest digest (so nothing is sent twice), and the secret behind the
-- one-click unsubscribe link at the foot of the mail.
--
-- A person with no row has the defaults: on, 60 minutes. The row appears when they change a setting, or when the first digest is claimed for them.
--
--  * `last_digest_at` is the watermark. A digest lists what arrived after it, and the next one is not sent before it is `delay_minutes` old. Turning
--    the digest back on moves it to now (a trigger), so switching it on does not send a mail of everything that piled up while it was off.
--  * `unsubscribe_key` signs the person's unsubscribe link (HMAC-SHA256 over their id). It is random, made once, never changed, so a link in an old mail
--    stays good. The people's own role (`manythreads_app`) is granted columns that leave it out, so no route or query as a person can read it; only the
--    system role (the digest job, the unsubscribe route) does.

CREATE TABLE app.notification_digest (
  person_id       uuid PRIMARY KEY REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT true,
  delay_minutes   integer NOT NULL DEFAULT 60 CHECK (delay_minutes BETWEEN 30 AND 1440),
  last_digest_at  timestamptz,
  unsubscribe_key text NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') CHECK (length(unsubscribe_key) = 64),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_digest_workspace ON app.notification_digest (workspace_id);
COMMENT ON TABLE app.notification_digest IS 'rls: person — P: a person''s own email digest settings and watermark; the system role (the digest job) claims and moves the watermark and reads the unsubscribe key, which the person role cannot select.';

ALTER TABLE app.notification_digest ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_digest FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_digest_system ON app.notification_digest FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY notification_digest_select ON app.notification_digest FOR SELECT
  USING (person_id = (SELECT app.person_id()));
CREATE POLICY notification_digest_insert ON app.notification_digest FOR INSERT
  WITH CHECK (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()));
CREATE POLICY notification_digest_update ON app.notification_digest FOR UPDATE
  USING (person_id = (SELECT app.person_id()))
  WITH CHECK (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()));

-- Column grants: a person reads and changes their settings, never the key, and never the watermark directly.
GRANT SELECT (person_id, workspace_id, enabled, delay_minutes, last_digest_at, updated_at) ON app.notification_digest TO manythreads_app;
GRANT INSERT (person_id, workspace_id, enabled, delay_minutes) ON app.notification_digest TO manythreads_app;
GRANT UPDATE (enabled, delay_minutes, updated_at) ON app.notification_digest TO manythreads_app;

-- Turning the digest back on starts a fresh window: what is unread now was either seen in the app or is not worth a mail of its own.
CREATE FUNCTION app.notification_digest_reenable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF OLD.enabled = false AND NEW.enabled = true THEN
    NEW.last_digest_at := greatest(coalesce(OLD.last_digest_at, '-infinity'::timestamptz), now());
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notification_digest_reenable BEFORE UPDATE OF enabled ON app.notification_digest
  FOR EACH ROW EXECUTE FUNCTION app.notification_digest_reenable();
