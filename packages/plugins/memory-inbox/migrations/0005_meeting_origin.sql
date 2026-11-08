-- memory-inbox 0005: items that come from a voice room (PLAN P15-11). Forward-only: never edit once applied.
--
-- A finished room's notes and transcript are filed into the team's memory as one markdown item with origin `meeting`, dropped by the platform (the system role) on behalf
-- of the people who said yes to being transcribed. The origin list grows by one, in the same change as the Zod enum `InboxOrigin`
-- (packages/shared/src/entities/inbox.ts). The insert policy for a person is unchanged: a person cannot drop an item with origin `meeting`.
ALTER TABLE app.memory_inbox_items DROP CONSTRAINT memory_inbox_items_origin_check;
ALTER TABLE app.memory_inbox_items ADD CONSTRAINT memory_inbox_items_origin_check
  CHECK (origin IN ('person', 'message', 'email', 'share', 'bot', 'meeting'));
