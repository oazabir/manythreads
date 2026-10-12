-- gateway-llm plugin 0001: what the LLM gateway is configured from (PLAN.md P5-06, SPEC §10.1). Forward-only: never edit once applied.
--
--  * llm_providers: one row per configured model provider (endpoint, kind, key). The key itself is in app.secrets through
--    secret_id — exactly as a sign-in provider's client secret is — so no route and no read ever sees it.
--  * llm_aliases: one row per alias the workspace has bound. The alias names are the vocabulary a BOT.md speaks
--    (`smart fast code local embed vision image transcribe`); a bot never names a model (SPEC §10.2). `fallbacks` is the
--    ordered list of aliases tried when this one fails; it is the `fallbacks:` half of the LiteLLM config.
--  * llm_keys: one live virtual key per bot, minted when the bot loads and revoked when it is removed (PLAN P5-06).
--    `secret_id` holds the key so the runtime (P5-10) can read it back at call time; `key_prefix` is the non-secret head
--    the workspace page shows. Deliberately no foreign key to app.bots: the row (and the secret) must outlive the bot
--    row long enough for the revoke job to delete the key in LiteLLM, and a daily reconcile (gateway-llm.reconcile) is
--    the safety net for a job that dead-lettered. Writes are the system job; workspace admins may read the prefix.
--
-- Ordering: this plugin depends on nothing but the kernel (it references app.workspaces, app.secrets and app.bots only
-- for documentation of the bot id), so its namespace migrates early and any plugin that needs it loads after.

-- llm_providers (W) -------------------------------------------------------------------------------------------------------
CREATE TABLE app.llm_providers (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('openai', 'anthropic', 'azure', 'bedrock', 'google', 'ollama', 'openai_compatible')),
  api_base     text,
  api_version  text,
  secret_id    uuid REFERENCES app.secrets (id),
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_providers_name_not_blank CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX llm_providers_workspace_name ON app.llm_providers (workspace_id, lower(name));
CREATE INDEX llm_providers_secret ON app.llm_providers (secret_id) WHERE secret_id IS NOT NULL;
COMMENT ON TABLE app.llm_providers IS 'rls: workspace — W: workspace admins read and write; the API key is secret_id, never a column (auth_providers follows the same shape).';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, secret_id ON app.llm_providers
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- llm_aliases (W) ---------------------------------------------------------------------------------------------------------
CREATE TABLE app.llm_aliases (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  alias        text NOT NULL CHECK (alias IN ('smart', 'fast', 'code', 'local', 'embed', 'vision', 'image', 'transcribe')),
  provider_id  uuid REFERENCES app.llm_providers (id) ON DELETE SET NULL,
  model        text NOT NULL,
  fallbacks    text[] NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, alias),
  CONSTRAINT llm_aliases_model_not_blank CHECK (btrim(model) <> ''),
  -- a chain of at most three, each one of the eight, no repeats and never the alias itself
  CONSTRAINT llm_aliases_fallbacks_shape CHECK (
    cardinality(fallbacks) <= 3
    AND fallbacks <@ ARRAY['smart', 'fast', 'code', 'local', 'embed', 'vision', 'image', 'transcribe']::text[]
    AND NOT (alias = ANY (fallbacks))
  )
);
CREATE INDEX llm_aliases_provider ON app.llm_aliases (provider_id) WHERE provider_id IS NOT NULL;
COMMENT ON TABLE app.llm_aliases IS 'rls: workspace — W: workspace admins bind each alias to a model and its fallback chain; a bot asks by alias, never by model.';
-- No workspace_refs_guard here: its provider_id branch validates against app.auth_providers (a sign-in provider), not ours;
-- the alias's FK to app.llm_providers plus the workspace RLS on both tables is the integrity check.

-- llm_keys (W) ------------------------------------------------------------------------------------------------------------
CREATE TABLE app.llm_keys (
  bot_id       uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  secret_id    uuid REFERENCES app.secrets (id),
  key_prefix   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CONSTRAINT llm_keys_prefix_shape CHECK (key_prefix ~ '^sk-[A-Za-z0-9_-]{4,12}$')
);
CREATE INDEX llm_keys_workspace_live ON app.llm_keys (workspace_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE app.llm_keys IS 'rls: workspace — W: a bot''s live gateway key (secret_id is the key, key_prefix its visible head); minted by the loader''s event and revoked with the bot, written only by the system job.';

-- Row level security ------------------------------------------------------------------------------------------------------
ALTER TABLE app.llm_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.llm_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY llm_providers_admin ON app.llm_providers FOR ALL
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.llm_providers TO manythreads_app;

ALTER TABLE app.llm_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.llm_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY llm_aliases_admin ON app.llm_aliases FOR ALL
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.llm_aliases TO manythreads_app;

ALTER TABLE app.llm_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.llm_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY llm_keys_select ON app.llm_keys FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY llm_keys_system ON app.llm_keys FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.llm_keys TO manythreads_app;

GRANT CREATE ON SCHEMA app TO manythreads_system;
