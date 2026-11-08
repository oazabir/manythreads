-- notifications 0007: "starts in 5 minutes" for a planned voice room (PLAN Bundle D, decision D7). Forward-only: never edit once applied.
--
-- Five minutes before a planned room is due, the meetings plugin's reminder job emits `meetings.scheduled.starting_soon` with the invited people of the workspace
-- (ids only). Each of them gets one notification of the new kind `meeting_soon`: "Design review starts in 5 minutes". Its reference type is `scheduled_meeting` and
-- `ref_id` is the plan's id (not a message): the table keeps one row per person and (ref_type, ref_id), so a second delivery of the same event changes nothing, and
-- opening the notification goes to the join page `/join/<id>`.

ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'reply', 'dm', 'message', 'reminder', 'meeting_actions', 'meeting_soon'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_ref_type_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_ref_type_check CHECK (ref_type IN ('message', 'reminder', 'meeting', 'scheduled_meeting'));
