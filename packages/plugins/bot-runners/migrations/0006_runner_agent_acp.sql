-- bot-runners 0006: two more words for what answers behind a gateway address (PLAN.md Phase 25, P25-05). Forward-only and additive: a server one version back
-- never writes the new words and never reads the column differently, so it still runs against this.
--
--   hermes-acp   Hermes started by the agent bridge (tools/agent-bridge) through its Agent Client Protocol door (`hermes acp`), one process per run. It is NOT a Hermes
--                gateway: like Claude Code and Codex on the bridge it gets the run's token and tools address in the request, and has no profile of its own.
--   opencode     OpenCode started the same way (`opencode acp`).
--
-- The protocol is the bridge's business, not a database word: `claude-code` and `codex` keep meaning the tool whichever way the bridge drives it. Only these two are
-- new, because they are new doors.
--
-- The list is shared with app.hermes_connections.agent (runtime-hermes 0003: the same words, the same CHECK), so both are widened here, and in the same order as
-- the Zod enum `HermesConnectionAgent`, which the kernel's schema-enums test compares. bot-runners depends on runtime-hermes, so that table exists.
-- The other constraints on the two columns (`bot_runners_agent_is_gateway`, `hermes_connections_managed_is_hermes`) are about `hermes` against the rest and stay as they are.
ALTER TABLE app.bot_runners
  DROP CONSTRAINT bot_runners_agent_check,
  ADD CONSTRAINT bot_runners_agent_check CHECK (agent IN ('hermes', 'claude-code', 'codex', 'hermes-acp', 'opencode'));

ALTER TABLE app.hermes_connections
  DROP CONSTRAINT hermes_connections_agent_check,
  ADD CONSTRAINT hermes_connections_agent_check CHECK (agent IN ('hermes', 'claude-code', 'codex', 'hermes-acp', 'opencode'));
