-- bots 0029 (P20-LV): the workspace Brain can hold a pairing token. Forward-only.
--
-- 0027 gave the Brain no team (`team_id` NULL), and `bots_pairing_mint` / `bots_pairing_revoke` still began with "no team means no such bot", so a token could never be made for it:
-- the Brain's profile on a Hermes gateway (the host's, or a team pod) had no credential the MCP address accepts, and every Brain run on a gateway ended in a 401 at its tools.
--
--  * A bot with scope = 'workspace' and no team is paired by the system role or by a workspace owner or admin (there is no team lead to ask). Every other rule is unchanged:
--    a team bot still needs the system role or a lead of its team (or an admin), and only an `active` bot can be paired.
--  * app.bots_pairing_resolve is unchanged: it answers the bot's team as NULL for the workspace bot. What a token of the workspace bot may do is decided by the run it is used in
--    (the gateway reads the bot's one open run, and that run's team is the context team); with no run open the token lists tools and acts for nobody.
-- Inside a definer function owned by the system role the is_* helpers are always true, so the caller is judged with lookup_workspace_role / lookup_can_team and coalesce.

CREATE OR REPLACE FUNCTION app.bots_pairing_mint(p_bot_id uuid, p_token_hash bytea) RETURNS TABLE (token_id uuid, minted_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_team   uuid;
  v_scope  text;
  v_status text;
BEGIN
  IF octet_length(p_token_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'a pairing token hash is 32 bytes' USING ERRCODE = 'data_exception';
  END IF;
  SELECT b.team_id, b.scope, b.status INTO v_team, v_scope, v_status FROM app.bots b WHERE b.id = p_bot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_team IS NULL AND v_scope IS DISTINCT FROM 'workspace' THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'no_data_found';
  END IF;
  IF session_user <> 'manythreads_system' THEN
    IF v_team IS NULL THEN
      IF NOT coalesce(app.lookup_workspace_role() IN ('owner', 'admin'), false) THEN
        RAISE EXCEPTION 'only a workspace admin can pair the workspace bot' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NOT coalesce(app.lookup_can_team(v_team, 'manage'), false) THEN
      RAISE EXCEPTION 'only a team lead or workspace admin can pair this bot' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  -- a token for a bot that cannot resolve would be a credential that does nothing (resolve answers active bots only)
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'this bot is %, only an active bot can be paired', v_status USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN QUERY INSERT INTO app.bot_pairing_tokens (bot_id, token_hash)
    VALUES (p_bot_id, p_token_hash)
    RETURNING id, created_at;
END
$$;

CREATE OR REPLACE FUNCTION app.bots_pairing_revoke(p_bot_id uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_team  uuid;
  v_scope text;
  v_count integer;
BEGIN
  SELECT b.team_id, b.scope INTO v_team, v_scope FROM app.bots b WHERE b.id = p_bot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_team IS NULL AND v_scope IS DISTINCT FROM 'workspace' THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'no_data_found';
  END IF;
  IF session_user <> 'manythreads_system' THEN
    IF v_team IS NULL THEN
      IF NOT coalesce(app.lookup_workspace_role() IN ('owner', 'admin'), false) THEN
        RAISE EXCEPTION 'only a workspace admin can pair the workspace bot' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NOT coalesce(app.lookup_can_team(v_team, 'manage'), false) THEN
      RAISE EXCEPTION 'only a team lead or workspace admin can pair this bot' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  UPDATE app.bot_pairing_tokens SET revoked_at = now() WHERE bot_id = p_bot_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
