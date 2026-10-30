-- notifications 0004: reminders (PLAN.md P14-04). Forward-only: never edit once applied.
--
-- A person's reminder ("remind me about this message") arrives as a notification of the new kind `reminder`, made by the consumer of the
-- reminders plugin's `reminders.reminder.due` event. Its reference type is `reminder` too, with `ref_id` still the message: the table keeps one
-- row per person and (ref_type, ref_id), and a message may already have made a mention or a reply for the same person, so the reminder has to
-- be a row of its own instead of raising that one. Opening it works as for any other: it names the message and its channel.

ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'reply', 'dm', 'message', 'reminder'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_ref_type_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_ref_type_check CHECK (ref_type IN ('message', 'reminder'));
