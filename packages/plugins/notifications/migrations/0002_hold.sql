-- notifications 0002: notifications held while the person has Do not disturb on (PLAN.md P14-01). Forward-only: never edit once applied.
--
-- A notification made during Do not disturb is still written (nothing is dropped), with `held_at` set. While it is held it is invisible to the
-- person: the inbox policies below only match rows with `held_at IS NULL`, so it is not listed, not counted and not marked read, and the
-- consumer sends no live push, browser alert or `notifications.notification.created` event for it. When Do not disturb ends, the consumer
-- clears `held_at` and does all of that then. `created_at` stays the moment the message arrived.

ALTER TABLE app.notifications ADD COLUMN held_at timestamptz;
CREATE INDEX notifications_held ON app.notifications (person_id) WHERE held_at IS NOT NULL;

DROP POLICY notifications_select_own ON app.notifications;
CREATE POLICY notifications_select_own ON app.notifications FOR SELECT
  USING (person_id = (SELECT app.person_id()) AND held_at IS NULL AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
DROP POLICY notifications_update_own ON app.notifications;
CREATE POLICY notifications_update_own ON app.notifications FOR UPDATE
  USING (person_id = (SELECT app.person_id()) AND held_at IS NULL) WITH CHECK (person_id = (SELECT app.person_id()));
