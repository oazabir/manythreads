-- bots plugin 0005: the two projections a run needs from a loaded definition (PLAN P5-10).
--
--  * triggers: the BOT.md `triggers` list as written, so routing a message to the bots it fires needs no repo read and no
--    re-parse of the file. The router (runtime-hermes) matches on it; nothing else reads it.
--  * native: the BOT.md `capabilities.native` list as written — the compiled allowlist, kept on the row so the loader can
--    resync `app.capability_grants` (grant what was added, drop what the file no longer lists) without re-reading the file it
--    replaced. `capability_grants` stays the truth the broker reads; this column only remembers what this bot's file asked for.
--
-- Both are the loader's own projection of one file, rewritten on every load, never written by a person or a bot.

ALTER TABLE app.bots ADD COLUMN triggers jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE app.bots ADD COLUMN native jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN app.bots.triggers IS 'The BOT.md triggers list as written (the router matches on it); the loader owns it.';
COMMENT ON COLUMN app.bots.native IS 'The BOT.md capabilities.native list as written; the loader resyncs app.capability_grants from it.';
