-- bot-runners 0005: what answers behind a Hermes gateway runner (PLAN.md Phase 19, P19-14). Forward-only and additive: a server one version back still runs
-- against it (its inserts take the default, its selects never name the column).
--
--   bot_runners.agent   `hermes` (a Hermes gateway, the default and what every row was until now), or `claude-code` / `codex` (the agent bridge,
--                       tools/agent-bridge, on a machine of the company's). Same three words and same CHECK as app.hermes_connections.agent. The run job sends a
--                       bridge agent the run's token and tools address; a Hermes agent never gets them. Only a gateway runner can name a bridge agent:
--                       the pod kinds say which program they run by their kind.
--
-- The column is not in app.bot_runners_for_team: a team still sees the same eight fields and learns nothing of what sits behind the address.
ALTER TABLE app.bot_runners
  ADD COLUMN agent text NOT NULL DEFAULT 'hermes' CHECK (agent IN ('hermes', 'claude-code', 'codex')),
  ADD CONSTRAINT bot_runners_agent_is_gateway CHECK (agent = 'hermes' OR kind = 'hermes_gateway');
