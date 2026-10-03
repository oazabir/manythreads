-- bots plugin 0002: the pairing door (PLAN P5-04). Forward-only: never edit once applied.
--
-- bot_pairing_tokens (0001) is system-only — no privilege for manythreads_app — so the only way in and out of it is these three narrow
-- SECURITY DEFINER functions, owned by manythreads_system (CLAUDE.md: non-system code reaches a system table through one, same scheme as
-- repo-git's writers and teams' invitation functions):
--
--   app.bots_pairing_mint(bot, sha256(token))   mint: the token is returned once, only its hash is stored.
--   app.bots_pairing_revoke(bot)                revoke: every live token of that bot and nothing else.
--   app.bots_pairing_resolve(sha256(token))     resolve: the ids behind a presented token, the bot's actor row with them — "a pairing
--                                                token resolves to a bot actor" (PLAN P5-04). The caller of resolve is whoever holds
--                                                the token (the gateway of P5-09, a rules run of P5-10): knowing the token IS the
--                                                credential (the same rule as app.teams_invitation_info), and the function returns
--                                                ids only, never a secret.
--
-- Who may mint or revoke: the system role, or a caller who may `manage` the bot's team. Inside a definer owned by the system role the
-- is_* helpers are always true, so the caller is checked with lookup_can_team and coalesce, never is_* (MISTAKES P2 review), and the
-- system role itself is recognized through session_user (the idiom of repo-git 0001).

-- Mint one pairing token: a 32-byte sha256 of a token the client generated; the raw token never reaches the database.
CREATE FUNCTION app.bots_pairing_mint(p_bot_id uuid, p_token_hash bytea) RETURNS TABLE (token_id uuid, minted_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_team uuid;
BEGIN
  IF octet_length(p_token_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'a pairing token hash is 32 bytes' USING ERRCODE = 'data_exception';
  END IF;
  SELECT b.team_id INTO v_team FROM app.bots b WHERE b.id = p_bot_id;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'no_data_found';
  END IF;
  IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_can_team(v_team, 'manage'), false) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin can pair this bot' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY INSERT INTO app.bot_pairing_tokens (bot_id, token_hash)
    VALUES (p_bot_id, p_token_hash)
    RETURNING id, created_at;
END
$$;

-- Revoke every live token of one bot (the settings page's "revoke"; returns how many went).
CREATE FUNCTION app.bots_pairing_revoke(p_bot_id uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_team  uuid;
  v_count integer;
BEGIN
  SELECT b.team_id INTO v_team FROM app.bots b WHERE b.id = p_bot_id;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'no_data_found';
  END IF;
  IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_can_team(v_team, 'manage'), false) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin can pair this bot' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.bot_pairing_tokens SET revoked_at = now() WHERE bot_id = p_bot_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- Resolve a presented token to its bot: the ids, the team and the bot's actor row. Revoked or unknown answers no rows.
CREATE FUNCTION app.bots_pairing_resolve(p_token_hash bytea)
  RETURNS TABLE (bot_id uuid, team_id uuid, workspace_id uuid, actor_id uuid, slug text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT b.id, b.team_id, b.workspace_id, a.id, b.slug
  FROM app.bot_pairing_tokens t
  JOIN app.bots b    ON b.id = t.bot_id
  JOIN app.actors a  ON a.kind = 'bot' AND a.workspace_id = b.workspace_id AND a.ref_id = b.id
  WHERE t.token_hash = p_token_hash AND t.revoked_at IS NULL
$$;

ALTER FUNCTION app.bots_pairing_mint(uuid, bytea) OWNER TO manythreads_system;
ALTER FUNCTION app.bots_pairing_revoke(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.bots_pairing_resolve(bytea) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.bots_pairing_mint(uuid, bytea), app.bots_pairing_revoke(uuid), app.bots_pairing_resolve(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bots_pairing_mint(uuid, bytea), app.bots_pairing_revoke(uuid), app.bots_pairing_resolve(bytea)
  TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.bots_pairing_resolve(bytea) IS
  'Resolve a presented pairing token (sha256) to its bot, team, workspace and actor; open to the app role because the token is the credential.';
