-- bots 0022: the `drop` trigger (PLAN P8-14, SPEC §12.2). Forward-only: never edit once applied.
--
-- A BOT.md may now say `triggers: [{ type: drop }]`: the bot is started by a file, note or message dropped into the team's memory inbox. The memory-inbox
-- plugin starts that run and the bot reads the one item through `inbox.read`. A run records which trigger fired it, so the list in the CHECK grows by one,
-- in the same change as the Zod enum `BotRunTrigger` (packages/shared/src/entities/bot.ts) and the BOT.md schema.
ALTER TABLE app.bot_runs DROP CONSTRAINT bot_runs_trigger_type_check;
ALTER TABLE app.bot_runs ADD CONSTRAINT bot_runs_trigger_type_check
  CHECK (trigger_type IN ('conversation', 'mention', 'routine', 'task_assigned', 'inbox', 'channel_message', 'webhook', 'drop'));
