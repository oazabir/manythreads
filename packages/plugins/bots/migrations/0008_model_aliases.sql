-- bots 0008: the model aliases a definition may ask for (review of P5-06). Forward-only: never edit once applied.
--
-- The LLM gateway mints each bot's virtual key limited to the aliases the bot's BOT.md names (`model.aliases` and
-- `model.fallbacks`); before this column it had no way to know them and handed every key every alias of the workspace. Like
-- `triggers` and `native` (0005) this is the loader's own projection of one file, rewritten on every load.

ALTER TABLE app.bots ADD COLUMN model_aliases text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN app.bots.model_aliases IS 'The aliases the BOT.md model block names (aliases, then fallbacks), in order, without repeats; the gateway limits the bot''s key to them. The loader owns it.';
