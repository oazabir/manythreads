-- workshop 0003: how many times a person pressed "Try again" on one "Add a bot" conversation (PLAN P7-02 review). Forward-only: never edit once applied.
--
-- A conversation that stopped can be run again from what was stored. Every run costs model calls, so the number of times is capped (three per conversation, in the route); this is the count it
-- checks. Same table, same policies: the person's own row, no new access.
ALTER TABLE app.setup_sessions ADD COLUMN retries integer NOT NULL DEFAULT 0 CHECK (retries >= 0);
