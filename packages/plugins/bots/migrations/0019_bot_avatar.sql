-- 0019_bot_avatar (P14-23): a bot's picture. Forward-only: never edit this file once applied.
--
-- `bots.avatar` is `preset:<id>` (one of the bot pictures the web app ships) or NULL (the initials are drawn). It is not part of BOT.md, so choosing a picture
-- is not a change to the bot's definition and needs no proposal: a lead of the bot's team or a workspace admin sets it through `app.bots_set_avatar`, the only
-- writer besides the system role (the loader's upsert does not name the column, so a reload keeps the choice).

ALTER TABLE app.bots
  ADD COLUMN avatar text CHECK (avatar IS NULL OR avatar ~ '^preset:bot-[a-z0-9-]{1,36}$');

CREATE FUNCTION app.bots_set_avatar(p_bot_id uuid, p_avatar text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_team uuid;
BEGIN
  SELECT b.team_id INTO v_team FROM app.bots b WHERE b.id = p_bot_id AND b.workspace_id = app.workspace_id();
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT app.lookup_can('team', v_team, 'manage') THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may choose a bot''s picture' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.bots SET avatar = p_avatar WHERE id = p_bot_id;
  RETURN p_avatar;
END
$$;
REVOKE ALL ON FUNCTION app.bots_set_avatar(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bots_set_avatar(uuid, text) TO manythreads_app;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.bots_set_avatar(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
