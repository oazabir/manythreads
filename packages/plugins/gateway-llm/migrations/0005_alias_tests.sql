-- gateway-llm 0005: the newest test call of each model alias (PLAN P10-01 step 2). Forward-only: never edit once applied.
--
-- An admin asks for one small question to be sent through an alias, the same way a bot's call goes (the pre-call check, the proxy, the provider), and
-- the result is kept here so the setup checklist can say "this model answers" from a fact rather than from a click. One row per (workspace, alias): a
-- new test replaces the old result. Whether the result still counts is not stored: the read compares `tested_at` with the alias's and its provider's
-- `updated_at`, so changing either one makes the result history without any job having to notice.
--
-- `message` is a fixed plain-language sentence the server chose for the cause, never the provider's own text (that can echo a key or a prompt).
-- `tested_by` carries no foreign key on purpose: it is an actor id (a person today) and the record should outlive them.

CREATE TABLE app.llm_alias_tests (
  workspace_id uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  alias        text        NOT NULL CHECK (alias IN ('smart', 'fast', 'code', 'local', 'embed', 'vision', 'image', 'transcribe')),
  outcome      text        NOT NULL CHECK (outcome IN ('ok', 'failed')),
  cause        text        CHECK (cause IN ('no_gateway', 'unbound', 'refused', 'auth', 'model_not_found', 'rate_limited', 'provider_error', 'timeout', 'unreachable', 'empty_answer', 'other')),
  message      text        NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
  model        text        CHECK (model IS NULL OR char_length(model) <= 200),
  latency_ms   integer     NOT NULL CHECK (latency_ms >= 0),
  tested_at    timestamptz NOT NULL DEFAULT now(),
  tested_by    uuid,
  PRIMARY KEY (workspace_id, alias),
  -- a result that worked has no cause; one that failed always has one
  CONSTRAINT llm_alias_tests_cause_pairs CHECK ((outcome = 'ok' AND cause IS NULL) OR (outcome = 'failed' AND cause IS NOT NULL))
);
COMMENT ON TABLE app.llm_alias_tests IS 'rls: workspace — W: workspace admins read the newest test call of each model alias; only the system role writes one (the test route runs the call as the system, like every platform-made model call).';

ALTER TABLE app.llm_alias_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.llm_alias_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY llm_alias_tests_read ON app.llm_alias_tests FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY llm_alias_tests_system ON app.llm_alias_tests FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.llm_alias_tests TO manythreads_app;
