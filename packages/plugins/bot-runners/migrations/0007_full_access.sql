-- bot-runners 0007: Codex full access, and a fifth runner kind for an agent on an enrolled server (PLAN.md Phase 26, P26-06; docs/plans/agents-anywhere.md §4).
-- Forward-only and additive: a server one version back never writes the new column or the new kind, and its inserts take the default.
--
--   bot_runners.full_access   true: Codex runs commands without asking (the `codex --yolo` behaviour, codex-acp's full-access mode). Only an admin sets it, only for a
--                             Codex runner (a `codex_cli` pod runner, or a `server_agent` runner whose agent is `codex`), and the route also keeps such a runner to one
--                             team. The bridge still honours it only when its own config allows it (the pod's controller or the server's installer flag): this column is
--                             the site's half of the two keys.
--   kind `server_agent`       one agent (Claude Code, Codex or Hermes) on an enrolled server, driven over the Agent Client Protocol. The rows and the columns that tie
--                             such a runner to its server arrive with the enrolled-server tasks (migration 0008). Same words, same order as the Zod enum `BotRunnerKind`.
--
-- `bot_runners_agent_is_gateway` (0005) said only a gateway runner can name a bridge agent; a server runner names its agent the same way, so the rule is widened.
-- The column is not in app.bot_runners_for_team: a team never learns how a runner is held.
ALTER TABLE app.bot_runners
  DROP CONSTRAINT bot_runners_kind_check,
  ADD CONSTRAINT bot_runners_kind_check CHECK (kind IN ('hermes_gateway', 'hermes_pod', 'claude_cli', 'codex_cli', 'llm_gateway', 'server_agent')),
  DROP CONSTRAINT bot_runners_agent_is_gateway,
  ADD CONSTRAINT bot_runners_agent_is_gateway CHECK (agent = 'hermes' OR kind IN ('hermes_gateway', 'server_agent')),
  ADD COLUMN full_access boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT bot_runners_full_access_codex CHECK (NOT full_access OR kind = 'codex_cli' OR (kind = 'server_agent' AND agent = 'codex'));

COMMENT ON COLUMN app.bot_runners.full_access IS 'Codex full access (docs/plans/agents-anywhere.md §4): true lets Codex run commands without asking. Codex runners only (CHECK); set only by PATCH /api/admin/bot-runners/:id/full-access, which keeps the runner to one team. Admin-only, never in a team view.';
