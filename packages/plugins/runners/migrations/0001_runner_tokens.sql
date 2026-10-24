-- runners plugin 0001: the runner credential (PLAN P6-06, SPEC §7.4). Forward-only: never edit once applied.
--
-- A runner is one program on a machine outside the cluster, holding one outbound connection to the server. The `runners` row belongs to the
-- tasks plugin (tasks 0001); what this adds is the credential the program presents when it connects:
--
--   runner_tokens   the sha256 of a live runner token and nothing else — like app.bot_pairing_tokens it keeps no privilege for
--                   manythreads_app; the connection route resolves it as the system role.
--
-- Two narrow SECURITY DEFINER doors, owned by manythreads_system (CLAUDE.md: non-system code reaches a system table through one):
--
--   app.runners_token_mint(runner, sha256(token))   mint: the token is returned once by the route, only its hash is stored.
--   app.runners_token_revoke(runner)                revoke: every live token of that runner and nothing else.
--
-- Who may mint or revoke: the system role, or a caller who may `manage` the runner's team (a lead or a workspace admin). Inside a definer
-- owned by the system role the is_* helpers are always true, so the caller is checked with lookup_can_team and coalesce, never is_*, and the
-- system role itself is recognised through session_user (the idiom of bots 0002).

-- runner_tokens (S) -------------------------------------------------------------------------------------------------------------
CREATE TABLE app.runner_tokens (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  runner_id  uuid NOT NULL REFERENCES app.runners (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX runner_tokens_live ON app.runner_tokens (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX runner_tokens_runner ON app.runner_tokens (runner_id);
COMMENT ON TABLE app.runner_tokens IS 'rls: system — S: sha256 of a live runner token (never the token itself); no privilege for manythreads_app, the connection route resolves it as the system role.';

ALTER TABLE app.runner_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.runner_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY runner_tokens_system ON app.runner_tokens FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: a credential table the request role never reads (like app.session_tokens)

CREATE FUNCTION app.runners_token_mint(p_runner_id uuid, p_token_hash bytea) RETURNS TABLE (token_id uuid, minted_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_team uuid;
BEGIN
  IF octet_length(p_token_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'a runner token hash is 32 bytes' USING ERRCODE = 'data_exception';
  END IF;
  SELECT r.team_id INTO v_team FROM app.runners r WHERE r.id = p_runner_id;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such runner' USING ERRCODE = 'no_data_found';
  END IF;
  IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_can_team(v_team, 'manage'), false) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin can mint a runner token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY INSERT INTO app.runner_tokens (runner_id, token_hash)
    VALUES (p_runner_id, p_token_hash)
    RETURNING id, created_at;
END
$$;

CREATE FUNCTION app.runners_token_revoke(p_runner_id uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_team  uuid;
  v_count integer;
BEGIN
  SELECT r.team_id INTO v_team FROM app.runners r WHERE r.id = p_runner_id;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such runner' USING ERRCODE = 'no_data_found';
  END IF;
  IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_can_team(v_team, 'manage'), false) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin can revoke a runner token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.runner_tokens SET revoked_at = now() WHERE runner_id = p_runner_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

ALTER FUNCTION app.runners_token_mint(uuid, bytea) OWNER TO manythreads_system;
ALTER FUNCTION app.runners_token_revoke(uuid) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.runners_token_mint(uuid, bytea), app.runners_token_revoke(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.runners_token_mint(uuid, bytea), app.runners_token_revoke(uuid) TO manythreads_app, manythreads_system;
