-- bots 0020: the connections a bot's BOT.md asks for, projected from `capabilities.connections` (PLAN P8-28). Forward-only: never edit once applied.
--
-- `[{ "connection": "<slug or person:*>", "tools": ["email.read", ...] }]`, written by the loader on every load like `native`, `triggers` and `knowledge`.
-- The connections plugin reads it on `bots.bot.loaded` and compiles it into its own grant rows; this column grants nothing by itself. NULL means the row was
-- loaded before this column existed: it reads as an empty list until the bot's BOT.md is applied again.
ALTER TABLE app.bots ADD COLUMN connections jsonb;
ALTER TABLE app.bots ADD CONSTRAINT bots_connections_shape CHECK (connections IS NULL OR (jsonb_typeof(connections) = 'array' AND jsonb_array_length(connections) <= 50));
