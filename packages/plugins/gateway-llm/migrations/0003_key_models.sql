-- gateway-llm 0003: which aliases a bot's virtual key was registered for (review of P5-06). Forward-only: never edit once applied.
--
-- A key is minted for the aliases the bot's definition names (and their fallback chains), and that set changes when the
-- BOT.md is edited or the workspace binds another alias. `models` remembers what the proxy was last told, so the sync can tell
-- "unchanged" (no call) from "changed" (`/key/update`) without asking the proxy. Rows from before this migration have `{}`,
-- which the sync treats as "not yet recorded" and corrects on its next pass; the proxy itself is never sent an empty list
-- (an empty `models` means every model to LiteLLM).

ALTER TABLE app.llm_keys ADD COLUMN models text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN app.llm_keys.models IS 'The aliases the key was last registered for with the proxy; written only by the system job.';
