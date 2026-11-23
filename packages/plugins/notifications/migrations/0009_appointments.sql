-- notifications 0009: the team schedule (P36-06, P36-07; docs/plans/team-schedule.md). Forward-only: never edit once applied.
--
-- `appointment_invite`: "Nadia invited you to Escalation review · Tue 15 Jan 14:00", when someone is invited to an appointment (as it is made, or added later).
-- `appointment_soon`: "Escalation review starts in 5 minutes", once per appointment (again if its time moves). Both point at the appointment (`ref_type`
-- `appointment_invite` and `appointment`, `ref_id` its id; two reference types so the two rows of one person do not collide) and belong to its meeting space
-- (`channel_id`), which opening one goes to.

ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'reply', 'dm', 'message', 'reminder', 'meeting_actions', 'meeting_soon', 'meeting_invite', 'appointment_invite', 'appointment_soon'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_ref_type_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_ref_type_check CHECK (ref_type IN ('message', 'reminder', 'meeting', 'scheduled_meeting', 'meeting_invite', 'appointment_invite', 'appointment'));
