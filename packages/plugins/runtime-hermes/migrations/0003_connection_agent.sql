-- runtime-hermes 0003: the agent behind a connection. Forward-only: never edit once applied.
--
-- Every connection speaks Hermes' run API. `hermes` is a Hermes gateway; `claude-code` and `codex` are the agent bridge, a small server that
-- answers the same API and starts one Claude Code or Codex command-line process per run. The team's own pod (`managed`) is always Hermes.
ALTER TABLE app.hermes_connections
  ADD COLUMN agent text NOT NULL DEFAULT 'hermes' CHECK (agent IN ('hermes', 'claude-code', 'codex')),
  ADD CONSTRAINT hermes_connections_managed_is_hermes CHECK (kind <> 'managed' OR agent = 'hermes');
