-- bots 0030: the two run triggers a voice room starts (PLAN P15-10, P15-18, P15-24). Forward-only: never edit once applied.
--
-- `meeting_ended`: a room ended and its transcript is written, so the team's Scribe (or the room's note-taker) writes the notes. `meeting_question`: someone in a room
-- with a note-taker asked it a question. The meetings plugin starts both; a run records which trigger fired it, so the list in the CHECK grows by two, in the same
-- change as the Zod enum `BotRunTrigger` (packages/shared/src/entities/bot.ts). The BOT.md triggers `meeting` and `meeting_ended` are Zod only (a definition is a file).
ALTER TABLE app.bot_runs DROP CONSTRAINT bot_runs_trigger_type_check;
ALTER TABLE app.bot_runs ADD CONSTRAINT bot_runs_trigger_type_check
  CHECK (trigger_type IN ('conversation', 'mention', 'routine', 'task_assigned', 'inbox', 'channel_message', 'webhook', 'drop', 'meeting_ended', 'meeting_question'));
