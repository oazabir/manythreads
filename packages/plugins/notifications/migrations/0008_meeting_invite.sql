-- notifications 0008: an invitation to a call (PLAN P15-27, docs/plans/calls-card.md step S5). Forward-only: never edit once applied.
--
-- When someone asks people to a live call (as it starts, or later with "Invite more"), the meetings plugin emits `meetings.invite.sent` with their ids. Each of them who can
-- still read the call's channel gets one notification of the new kind `meeting_invite`: "Nadia invited you to Design review". Its reference type is `meeting_invite` and
-- `ref_id` is the meeting's id; `thread_root_id` is the call's start message (the call card), which opening it goes to. The reference type is its own, not `meeting`: action
-- items of the same meeting use `meeting`, and the table keeps one row per person and (ref_type, ref_id), so the two would collide. A second delivery of the same event
-- changes nothing. A call in a direct message makes no invitation: everyone in it is rung.

ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'reply', 'dm', 'message', 'reminder', 'meeting_actions', 'meeting_soon', 'meeting_invite'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_ref_type_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_ref_type_check CHECK (ref_type IN ('message', 'reminder', 'meeting', 'scheduled_meeting', 'meeting_invite'));
