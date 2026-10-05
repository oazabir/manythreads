-- bots plugin 0003: the two fields a roster cannot do without (PLAN P5-05). The definition stays the repo's file; `name` and `role`
-- are the loader's copy of it, so drawing the roster is one query instead of one repo read per bot. The loader writes both on every
-- load, which is why a definition that changes its `name` shows the new one on the next commit.
--
-- Backfill: rows that loaded before this migration have neither field. `slug` is the honest name to fall back on (it is what the
-- folder says), and an empty role reads as "not described yet" rather than inventing prose the author never wrote.

ALTER TABLE app.bots ADD COLUMN name text NOT NULL DEFAULT '';
ALTER TABLE app.bots ADD COLUMN role text NOT NULL DEFAULT '';
ALTER TABLE app.bots ADD COLUMN may_tag text[] NOT NULL DEFAULT '{}';
UPDATE app.bots SET name = slug WHERE name = '';

COMMENT ON COLUMN app.bots.name IS 'The definition''s `name`, copied by the loader (P5-04); the roster''s row title.';
COMMENT ON COLUMN app.bots.role IS 'The definition''s `role` line, copied by the loader; the roster''s row subtitle (may be empty).';
-- The compiled `handover.mayTag` the loader also writes into the bot's `tasks.handoff` grant. The grant is what the broker enforces;
-- this column is the roster's copy, so drawing it needs no join through `app.actors` (which a non-member admin cannot read anyway).
COMMENT ON COLUMN app.bots.may_tag IS 'The compiled `handover.mayTag` (PLAN P5-04), display copy of the bot''s tasks.handoff grant.';

-- The roster orders by name, and the bot page looks one up by slug: `bots_team_slug` already serves the lookup, this serves the order.
CREATE INDEX bots_team_name ON app.bots (team_id, name);