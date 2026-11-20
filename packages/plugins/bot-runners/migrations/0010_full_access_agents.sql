-- bot-runners 0010: full access for Claude Code as well as Codex (PLAN.md P35-01, docs/plans/full-access-default.md; owner decision 2026-11-20). Forward-only and additive: a server one
-- version back writes full_access only for a Codex runner, which the wider check still allows, and never reads the new table.
--
--   bot_runners_full_access_agent   full access is allowed for a Claude Code or Codex pod runner (`claude_cli`, `codex_cli`) and for a server runner whose agent is Claude Code or
--                                   Codex. Never for Hermes (pod or gateway: the host bridge of mode A never gets it, conventions.md) or the LLM gateway, which have no command
--                                   questions of their own to bypass. Replaces `bot_runners_full_access_codex` (0007).
--   full_access default             stays false: the adoption of Hermes rows and the server sync insert without naming the column. A new Claude Code or Codex runner is written
--                                   with true by its route and by the server sync.
--   app.bot_runner_data_steps       the markers of the plugin's one-off data steps (src/data-steps.ts): a step's name is written in the transaction that makes its change, and a
--                                   step whose name is here never runs again. Switching the existing runners on is such a step, not SQL here, so each runner gets its audited
--                                   `bot_runner.runner.updated` event through the outbox. System only.
ALTER TABLE app.bot_runners
  DROP CONSTRAINT bot_runners_full_access_codex,
  ADD CONSTRAINT bot_runners_full_access_agent CHECK (NOT full_access OR kind IN ('claude_cli', 'codex_cli') OR (kind = 'server_agent' AND agent IN ('claude-code', 'codex')));

COMMENT ON COLUMN app.bot_runners.full_access IS 'Full access (docs/plans/full-access-default.md): true lets Claude Code or Codex run commands without asking. Claude Code and Codex runners only (CHECK bot_runners_full_access_agent); on by default for a new one (written by the route and the server sync), an admin switches it off. The bridge also needs its own config to allow it. Admin-only, never in a team view.';

CREATE TABLE app.bot_runner_data_steps (
  step     text PRIMARY KEY CHECK (step ~ '^[a-z0-9-]{1,80}$'),
  done_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.bot_runner_data_steps IS 'rls: system — S: the one-off data steps of bot-runners that have run (src/data-steps.ts), one row per step; no privilege for manythreads_app.';
ALTER TABLE app.bot_runner_data_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_runner_data_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY bot_runner_data_steps_system ON app.bot_runner_data_steps FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
