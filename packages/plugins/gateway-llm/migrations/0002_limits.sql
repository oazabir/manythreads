-- gateway-llm plugin 0002: what the gateway enforces before a call, and what it records after one (PLAN.md P5-07, SPEC
-- §10.1, §15). Forward-only: never edit once applied.
--
--  * llm_limits: budgets workspace → team → bot → session and the rate limit beside them. One row per target; a row
--    carries a spend cap, a calls-per-minute cap, or both (never neither). A call must pass every scope that applies to
--    it, and the narrowest exhausted one is the one the refusal names.
--  * llm_settings: the workspace's guard preset (standard, strict-egress, air-gapped, customer-facing), the hosts
--    strict-egress may reach, and the caching flag. A workspace with no row is the default: standard, no allowlist,
--    caching on — so nothing has to be seeded.
--  * llm_spend: the append-only ledger of what model calls cost (the audit trail of spend and the input to a budget
--    check). No UPDATE and no DELETE grant: a line, once written, is the record.
--
-- Ordering: like 0001 this plugin needs nothing but the kernel (and app.teams for the same-workspace guard), so its
-- namespace migrates early. team_id and bot_id carry no foreign key on purpose: the ledger must outlive a deleted team
-- or bot (that is the point of an audit trail), and `app.bots` is another plugin's table (0001 recorded the same
-- decision for llm_keys). The same-workspace guard covers team_id; the route checks bot_id before it writes.

-- llm_limits (W) ----------------------------------------------------------------------------------------------------------
CREATE TABLE app.llm_limits (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  scope               text NOT NULL CHECK (scope IN ('workspace', 'team', 'bot', 'session')),
  team_id             uuid,
  bot_id              uuid,
  budget_window       text NOT NULL DEFAULT 'day' CHECK (budget_window IN ('day', 'month')),
  limit_usd           numeric(14, 6) CHECK (limit_usd IS NULL OR limit_usd >= 0),
  requests_per_minute integer CHECK (requests_per_minute IS NULL OR requests_per_minute > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- the target each scope needs: a team id for team, a bot id for bot and session, nothing for workspace
  CONSTRAINT llm_limits_target_shape CHECK (
    (scope = 'workspace' AND team_id IS NULL AND bot_id IS NULL)
    OR (scope = 'team' AND team_id IS NOT NULL AND bot_id IS NULL)
    OR (scope IN ('bot', 'session') AND team_id IS NULL AND bot_id IS NOT NULL)
  ),
  -- a row that caps nothing is not a limit; delete it instead
  CONSTRAINT llm_limits_has_a_cap CHECK (limit_usd IS NOT NULL OR requests_per_minute IS NOT NULL)
);
-- One row per (workspace, scope, target). The coalesce spells "no target here" the way the index needs it; the route
-- reads the target back before writing, so it upserts by hand rather than through ON CONFLICT on an expression.
CREATE UNIQUE INDEX llm_limits_target ON app.llm_limits (
  workspace_id, scope, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(bot_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX llm_limits_bot ON app.llm_limits (bot_id) WHERE bot_id IS NOT NULL;
COMMENT ON TABLE app.llm_limits IS 'rls: workspace — W: workspace admins set the budgets and rate limits of every scope; the runtime reads them in the system transaction that enforces them before a call.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id ON app.llm_limits
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- llm_settings (W) -------------------------------------------------------------------------------------------------------
CREATE TABLE app.llm_settings (
  workspace_id     uuid PRIMARY KEY REFERENCES app.workspaces (id) ON DELETE CASCADE,
  preset           text NOT NULL DEFAULT 'standard'
                     CHECK (preset IN ('standard', 'strict-egress', 'air-gapped', 'customer-facing')),
  egress_allowlist text[] NOT NULL DEFAULT '{}',
  caching          boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.llm_settings IS 'rls: workspace — W: workspace admins choose the guard preset, the hosts strict-egress may reach and caching; a workspace with no row runs the default (standard, caching on, nothing allowlisted).';

-- llm_spend (append-only W) ----------------------------------------------------------------------------------------------
CREATE TABLE app.llm_spend (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id           uuid,
  bot_id            uuid,
  session_id        text,
  run_id            uuid,
  alias             text NOT NULL CHECK (alias IN ('smart', 'fast', 'code', 'local', 'embed', 'vision', 'image', 'transcribe')),
  model             text,
  prompt_tokens     integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  cost_usd          numeric(14, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
-- The budget check reads one scope's window, so both of those are covered: the workspace total (its time range) and a
-- bot or team total. `session_id` is the one unbounded target (a session budget covers the whole session).
CREATE INDEX llm_spend_workspace_time ON app.llm_spend (workspace_id, occurred_at DESC);
CREATE INDEX llm_spend_bot_time ON app.llm_spend (bot_id, occurred_at DESC) WHERE bot_id IS NOT NULL;
CREATE INDEX llm_spend_team_time ON app.llm_spend (team_id, occurred_at DESC) WHERE team_id IS NOT NULL;
CREATE INDEX llm_spend_session ON app.llm_spend (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX llm_spend_time_brin ON app.llm_spend USING brin (occurred_at);
COMMENT ON TABLE app.llm_spend IS 'rls: workspace — W: workspace admins read what the workspace spent; only the system role writes a line, and no role may change one (append-only, no UPDATE or DELETE grant).';

-- Row level security -----------------------------------------------------------------------------------------------------
ALTER TABLE app.llm_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.llm_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY llm_limits_admin ON app.llm_limits FOR ALL
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.llm_limits TO manythreads_app;

ALTER TABLE app.llm_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.llm_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY llm_settings_admin ON app.llm_settings FOR ALL
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.llm_settings TO manythreads_app;

ALTER TABLE app.llm_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.llm_spend FORCE ROW LEVEL SECURITY;
-- Reading spend is admin-only (a team lead does not see what a team's bots cost through this table; the page is a
-- workspace-admin page, like the rest of Workspace → LLM).
CREATE POLICY llm_spend_read ON app.llm_spend FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
-- Only the system role writes a line, so the gateway's audit of a call cannot be edited by the caller it describes.
CREATE POLICY llm_spend_write ON app.llm_spend FOR INSERT WITH CHECK ((SELECT app.is_system()));
GRANT SELECT, INSERT ON app.llm_spend TO manythreads_app;
REVOKE UPDATE, DELETE, TRUNCATE ON app.llm_spend FROM manythreads_app;
