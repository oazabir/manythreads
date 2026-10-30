-- bots 0017: the knowledge bases a bot may search, projected from its BOT.md `knowledge:` list (PLAN P8-08). Forward-only: never edit once applied.
--
-- `[{ "base": "<slug>", "answer_only_from": true|false }]`, written by the loader on every load like `triggers` and `native`. An empty list means
-- the definition names no base, and the knowledge tool then searches every base of the bot's team. NULL means the row was loaded before this column
-- existed: it reads as an empty list until the bot's BOT.md is applied again (the loader fills the column then).
ALTER TABLE app.bots ADD COLUMN knowledge jsonb;
ALTER TABLE app.bots ADD CONSTRAINT bots_knowledge_shape CHECK (knowledge IS NULL OR (jsonb_typeof(knowledge) = 'array' AND jsonb_array_length(knowledge) <= 50));
