-- gateway-llm 0006: what a ledger line was for (PLAN P7-05 follow-up). Forward-only: never edit once applied.
--
-- Every line of `llm_spend` said which bot, team and session a call belonged to, but not what kind of call it was, so the setup helper's calls ("Add a bot"), the Workshop helper's and the
-- admin's model tests all read "no bot" on the Spend page. `purpose` is the kind: `run` (a bot's own work), `setup` (the Add a bot helper), `workshop` (the Workshop tab's Build and Live
-- helpers), `rehearsal` (a rehearsal of a bot), `gate` (the safety check), `eval` (a bot's scenario run), `alias-test` (an admin's test of a model). Older lines have none (null). Free text
-- within a short length, not an enum: a new kind must not need a migration. The table stays append-only (no UPDATE grant), so the column is only ever written by the insert.

ALTER TABLE app.llm_spend ADD COLUMN purpose text CHECK (purpose IS NULL OR char_length(purpose) BETWEEN 1 AND 40);
