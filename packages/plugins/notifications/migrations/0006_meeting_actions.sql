-- notifications 0006: action items from a meeting (PLAN P15-12, decision C9). Forward-only: never edit once applied.
--
-- When the Scribe has written a finished voice room's notes, each person an action item was given to (an exact match with a team member's name) is told once:
-- "2 action items from <title>". It is a notification of the new kind `meeting_actions`, made by the consumer of the meetings plugin's `meetings.notes.written` event.
-- Its reference type is `meeting` and `ref_id` is the meeting's id (not a message): the table still keeps one row per person and (ref_type, ref_id), so a second
-- delivery of the same event changes nothing, and opening the notification goes to the meeting page.

ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'reply', 'dm', 'message', 'reminder', 'meeting_actions'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_ref_type_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_ref_type_check CHECK (ref_type IN ('message', 'reminder', 'meeting'));
