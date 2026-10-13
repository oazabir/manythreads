-- channels 0007: one Answer per bot run (PLAN P5-18 review). Forward-only: never edit once applied.
--
-- A bot run finishes with at most one Answer (`answer.post`, docs/plugins/answer.md). The answer plugin serialises the calls of one run with an
-- advisory lock and answers `already_answered` to the second; this index is the guarantee that does not depend on that code being the only
-- writer: a second live message of the same run that carries `meta.answer` is refused by the database (23505) whatever wrote it.
--
-- Partial on purpose: only messages that carry an answer are indexed (a handful per run, none in a table of ordinary messages), and a message
-- that was deleted leaves the index — the person removed the answer, so the run is no longer "answered" (the answer plugin reads it the same
-- way). `meta ->> 'runId'` is written by the `messages` provider alone, which refuses a run id that is not the transaction's own run.

CREATE UNIQUE INDEX messages_one_answer_per_run ON app.messages ((meta ->> 'runId'))
  WHERE meta ? 'answer' AND deleted_at IS NULL;
