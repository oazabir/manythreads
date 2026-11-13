-- approvals plugin 0005: a fifth source, `agent` (PLAN P24-01). Forward-only: never edit once applied.
--
-- The four sources say why the PLATFORM stopped a call (a flagged tool, a guard, a protected environment, a strict hand-off). `agent` is the other
-- direction: the bot's own program stopped to ask a person, either because its shell wanted to run a command it thinks is risky (the program waits
-- inside the run for the answer) or because the bot called the `approvals.ask` tool with a question. Both are handed back to the runtime that
-- asked (`resume.kind = 'handoff'`), so no new resume kind and no change to the decide route is needed.
--
-- The column is plain text with a CHECK, so the change is one constraint. The name is the one Postgres gave the inline CHECK of 0001.
ALTER TABLE app.approvals DROP CONSTRAINT approvals_source_check;
ALTER TABLE app.approvals ADD CONSTRAINT approvals_source_check CHECK (source IN ('environment', 'dispatch', 'dlp', 'grant', 'agent'));
