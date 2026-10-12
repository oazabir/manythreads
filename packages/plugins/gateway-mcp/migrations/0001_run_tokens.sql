-- gateway-mcp 0001: one credential per bot run (PLAN P5-09, decision in docs/spikes/per-run-scoping.md).
--
--  * mcp_run_tokens: the sha256 of a run's endpoint token, the run it belongs to and when it stops working. The
--    token itself is returned once by the mint and never stored — like app.bot_pairing_tokens and app.session_tokens.
--    The kernel's run service (ctx.runs) is the only reader and writer: it mints as the system actor and resolves a
--    presented token to the run it opens. Manythreads_app never touches this table (no GRANT), so a request can
--    neither read a live token nor mint one on its own.
--  * Why per run and not per bot: Hermes has no per-run tool-scope primitive (docs/spikes/per-run-scoping.md), so
--    the gateway mints one URL and one token per run and the runtime launches one invocation per run. A forged or
--    cross-run token resolves to nothing.
--
-- Ordering: the manifest's `dependsOn: ['bots']` puts this after app.bots and app.bot_runs.

CREATE TABLE app.mcp_run_tokens (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id     uuid NOT NULL REFERENCES app.bot_runs (id) ON DELETE CASCADE,
  bot_id     uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT mcp_run_tokens_expires_after_created CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX mcp_run_tokens_live ON app.mcp_run_tokens (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX mcp_run_tokens_run ON app.mcp_run_tokens (run_id);
COMMENT ON TABLE app.mcp_run_tokens IS 'rls: system — S: sha256 of a live run endpoint token, its run and its expiry; written and read by the kernel run service (ctx.runs) as the system role, no privilege for manythreads_app.';

ALTER TABLE app.mcp_run_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mcp_run_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_run_tokens_system ON app.mcp_run_tokens FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: a credential table the request role never reads

GRANT CREATE ON SCHEMA app TO manythreads_system;
