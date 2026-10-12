-- bots plugin 0006: review fixes to 0001/0002/0003 (PLAN P5 review). Forward-only: never edit once applied.
--
--  1. app.bots_pairing_resolve (0002) joined tokens to bots without looking at the bot's status, so the token of a disabled or invalid
--     bot still resolved to the bot actor. It resolves an `active` bot only; an existing token of a bot that comes back to `active` works
--     again, which is the point of a pause.
--  2. bots.invalid_reason: why the LAST load of this bot's BOT.md failed, null while the definition loads. The roster used to read the
--     newest `bots.bot.invalid` event, which kept showing a repaired file as broken (and scanned the team's whole event tail). The
--     event stays the alert; the column is the page's state, set and cleared by the loader in the same transaction as `status`.
--  3. bot_runs.bot_id and bot_runs.team_id could disagree: the INSERT policy checked the team the caller can read, never that the bot
--     belongs to it, and let a caller insert a run already `done`. A composite foreign key ties the pair; the policy only admits a
--     run that starts running.

-- 1 -----------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.bots_pairing_resolve(p_token_hash bytea)
  RETURNS TABLE (bot_id uuid, team_id uuid, workspace_id uuid, actor_id uuid, slug text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT b.id, b.team_id, b.workspace_id, a.id, b.slug
  FROM app.bot_pairing_tokens t
  JOIN app.bots b    ON b.id = t.bot_id AND b.status = 'active'
  JOIN app.actors a  ON a.kind = 'bot' AND a.workspace_id = b.workspace_id AND a.ref_id = b.id
  WHERE t.token_hash = p_token_hash AND t.revoked_at IS NULL
$$;

CREATE OR REPLACE FUNCTION app.bots_pairing_mint(p_bot_id uuid, p_token_hash bytea) RETURNS TABLE (token_id uuid, minted_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_team   uuid;
  v_status text;
BEGIN
  IF octet_length(p_token_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'a pairing token hash is 32 bytes' USING ERRCODE = 'data_exception';
  END IF;
  SELECT b.team_id, b.status INTO v_team, v_status FROM app.bots b WHERE b.id = p_bot_id;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'no_data_found';
  END IF;
  IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_can_team(v_team, 'manage'), false) THEN
    RAISE EXCEPTION 'only a team lead or workspace admin can pair this bot' USING ERRCODE = 'insufficient_privilege';
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

-- 2 -----------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.bots ADD COLUMN invalid_reason jsonb;
ALTER TABLE app.bots ADD CONSTRAINT bots_invalid_reason_shape CHECK (invalid_reason IS NULL OR jsonb_typeof(invalid_reason) = 'object');
COMMENT ON COLUMN app.bots.invalid_reason IS
  'Why the last load of BOT.md failed ({fieldPath, message, at, definitionSha}); null while the definition loads. Written by the loader only.';
-- Backfill: a row already `invalid` takes the reason of its newest `bots.bot.invalid` event, in the shape the roster now reads:
-- {fieldPath, message, at, definitionSha}. (A repaired row is `active`, so it is not touched.) If the migration role cannot see
-- app.events through its row-level security (a non-superuser owner), this updates nothing and the next commit to the file writes the reason.
UPDATE app.bots b
   SET invalid_reason = jsonb_build_object(
         'fieldPath', e.payload->'fieldPath',
         'message', e.payload->>'message',
         'at', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'definitionSha', e.payload->>'definitionSha')
  FROM (
    SELECT DISTINCT ON (payload->>'botId') payload, occurred_at, payload->>'botId' AS bot_id
      FROM app.events
     WHERE type = 'bots.bot.invalid' AND payload->>'botId' IS NOT NULL
     ORDER BY payload->>'botId', occurred_at DESC, id DESC
  ) e
 WHERE b.status = 'invalid' AND b.id::text = e.bot_id;

-- 3 -----------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.bots ADD CONSTRAINT bots_id_team UNIQUE (id, team_id);
ALTER TABLE app.bot_runs DROP CONSTRAINT bot_runs_bot_id_fkey;
ALTER TABLE app.bot_runs ADD CONSTRAINT bot_runs_bot_team_fkey FOREIGN KEY (bot_id, team_id) REFERENCES app.bots (id, team_id) ON DELETE CASCADE;

DROP POLICY bot_runs_insert ON app.bot_runs;
CREATE POLICY bot_runs_insert ON app.bot_runs FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id())
      AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
      AND asker_id = (SELECT app.actor())
      AND status = 'running'
      AND ended_at IS NULL));
