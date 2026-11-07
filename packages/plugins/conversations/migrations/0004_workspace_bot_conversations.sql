-- conversations 0004 (P20-07): a person talks to the workspace Brain, a bot with no team of its own. Forward-only.
--
-- app.conversations_open(bot) is the same door with one change: when the bot is the workspace bot (scope = 'workspace', no team), the conversation channel lives in
-- the CONTEXT team, the first team the person belongs to (app.workspace_bot_context_team, bots 0027). The channel is made once per (bot, person), so that team is
-- fixed by the first conversation. The person must belong to that team (the run is opened for a person of the run's team), and a person of no team cannot start one.
-- A team bot behaves as before.
CREATE OR REPLACE FUNCTION app.conversations_open(p_bot_id uuid) RETURNS TABLE (channel_id uuid, created boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws      uuid := app.workspace_id();
  v_role    text := app.lookup_workspace_role();
  v_me      uuid;
  v_team    uuid;
  v_scope   text;
  v_found   boolean;
  v_status  text;
  v_new     uuid := uuidv7();
  v_channel uuid;
BEGIN
  SELECT a.ref_id INTO v_me FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = v_ws;
  -- A guest's reach is the channels they were granted, and a bot does not talk to a bot: neither opens a conversation.
  IF v_me IS NULL OR v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'only members of the workspace can talk to a bot' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT b.team_id, b.status, b.scope, true INTO v_team, v_status, v_scope, v_found FROM app.bots b WHERE b.id = p_bot_id AND b.workspace_id = v_ws;
  IF v_found IS NOT TRUE THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_scope = 'workspace' AND v_team IS NULL THEN
    v_team := app.workspace_bot_context_team(v_me);
    IF v_team IS NULL THEN
      RAISE EXCEPTION 'join a team first: the Brain answers in the context of one of your teams' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  -- The run that answers is opened for a person of the run's team (ctx.runs.open refuses anybody else), so only they may start one.
  IF NOT EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                  WHERE tm.team_id = v_team AND a.ref_id = v_me) THEN
    RAISE EXCEPTION 'only people of the bot''s team can talk to it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'this bot is not active' USING ERRCODE = 'check_violation';
  END IF;
  WITH ch AS (
    INSERT INTO app.channels AS c (id, workspace_id, team_id, name, kind, private, bot_id, created_by)
    VALUES (v_new, v_ws, v_team, '', 'bot_conversation', true, p_bot_id, app.actor())
    ON CONFLICT (workspace_id, bot_id, created_by) WHERE kind = 'bot_conversation' DO SELECT
    RETURNING c.id
  ), members AS (
    INSERT INTO app.channel_members (channel_id, person_id)
    SELECT ch.id, v_me FROM ch
    ON CONFLICT DO NOTHING
  )
  SELECT ch.id INTO v_channel FROM ch;
  RETURN QUERY SELECT v_channel, v_channel = v_new;
END
$$;
