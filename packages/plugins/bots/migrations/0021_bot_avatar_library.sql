-- 0021_bot_avatar_library (P14-24): a picture for every bot, and Brain's picture is an admin's to change. Forward-only: never edit this file once applied.
--
-- 1. `app.bot_default_avatar(id, slug)`: the picture a bot that has none is given by this migration. Brain gets the chip; every other bot gets one of the 19
--    animal pictures, picked from the md5 of its id, so running the statement again gives the same answer and a bot that already has a picture is never touched.
--    (A bot created from now on is given a random animal by the loader, in the same transaction as its row; this function is only the backfill.) The list is
--    in the order of BOT_ANIMAL_AVATAR_PRESETS in `packages/shared/src/entities/avatar.ts`; a test keeps the two equal.
-- 2. The backfill itself: bots whose `avatar` is NULL get `bot_default_avatar`. It runs as the system role because `bots` is FORCE ROW LEVEL SECURITY and only
--    that role may update it (the owner would update zero rows, silently).
-- 3. `app.bots_set_avatar` again, with one more rule: Brain's picture (slug `brain`) can be changed only by a workspace owner or admin, not by the team's lead.

CREATE FUNCTION app.bot_default_avatar(p_id uuid, p_slug text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_slug = 'brain' THEN 'preset:bot-brain-chip'
    ELSE 'preset:' || (ARRAY[
      'bot-noto-bear', 'bot-noto-cat', 'bot-noto-chick', 'bot-noto-cow', 'bot-noto-dog', 'bot-noto-dolphin', 'bot-noto-duck', 'bot-noto-fox',
      'bot-noto-frog', 'bot-noto-hamster', 'bot-noto-koala', 'bot-noto-lion', 'bot-noto-monkey', 'bot-noto-mouse', 'bot-noto-panda',
      'bot-noto-rabbit', 'bot-noto-sloth', 'bot-noto-t-rex', 'bot-noto-tiger'
    ])[1 + (('x' || substr(md5(p_id::text), 1, 8))::bit(32)::bigint % 19)::int]
  END
$$;

-- legacy-begin
SET ROLE manythreads_system;
UPDATE app.bots SET avatar = app.bot_default_avatar(id, slug) WHERE avatar IS NULL;
RESET ROLE;
-- legacy-end

DROP FUNCTION app.bots_set_avatar(uuid, text);
CREATE FUNCTION app.bots_set_avatar(p_bot_id uuid, p_avatar text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_team uuid;
  v_slug text;
BEGIN
  SELECT b.team_id, b.slug INTO v_team, v_slug FROM app.bots b WHERE b.id = p_bot_id AND b.workspace_id = app.workspace_id();
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_slug = 'brain' THEN
    -- inside a definer function the is_* helpers are TRUE, so the caller's own role is read (conventions: lookup_workspace_role)
    IF coalesce(app.lookup_workspace_role() NOT IN ('owner', 'admin'), true) THEN
      RAISE EXCEPTION 'only a workspace admin may change Brain''s picture' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NOT app.lookup_can('team', v_team, 'manage') THEN
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
