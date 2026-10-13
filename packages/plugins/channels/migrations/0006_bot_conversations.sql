-- channels 0006: bot conversations (PLAN P5-16, SPEC §6.2). Forward-only: never edit once applied.
--
-- A conversation with a bot lives in a channel of kind 'bot_conversation' (0001 reserved the kind and its shape: private, `bot_id`). The
-- conversations plugin makes one per (bot, person) — private to that person, so that every rule that already follows a channel's
-- visibility (messages, threads, reactions, search, read state, notifications, the Threads inbox) keeps one person's conversation from
-- another with no rule of its own. What this file changes is the two things the channels plugin itself owns:
--
--  1. The bot's side of the channel. A bot actor sees only public channels of its team (0004), so it could not post its reply into a
--     private channel. A bot now reads and posts in a bot conversation channel only while one of ITS OWN live runs answers there
--     (`bot_runs.channel_id`): the run is the bot's authority (PLAN P5-10), and the channel is the one that run was opened for. A bot
--     never sees the conversation channels it has with other people in a run for somebody else, nor outside any run.
--  2. Nobody leaves a bot conversation (the person's membership is what makes the channel theirs, like a DM).
--
-- `channel_audience` needs no change: it lists people, and a bot conversation's people are its members, who must still sit on the
-- channel's team (0004). The channel carries its bot's team (`team_id`), so a person who leaves the team stops reading their
-- conversations and the router finds the bot's team from the channel.

CREATE OR REPLACE FUNCTION app.visible_channel_ids(p_permission text DEFAULT 'read') RETURNS uuid[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws      uuid := app.workspace_id();
  v_actor   uuid := app.actor();
  v_kind    text;
  v_ref     uuid;
  v_role    text;
  v_teams   uuid[];
  v_member  uuid[];
  v_acl     uuid[];
  v_run     uuid;
  v_conv    uuid[] := '{}'::uuid[];
BEGIN
  IF p_permission NOT IN ('read', 'post') OR v_ws IS NULL OR v_actor IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  SELECT a.kind, a.ref_id INTO v_kind, v_ref FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
  IF v_kind IS NULL OR v_kind = 'system' THEN
    RETURN '{}'::uuid[];
  END IF;
  IF v_kind = 'person' THEN
    v_role := app.lookup_workspace_role();   -- NULL: suspended or no membership
    IF v_role IS NULL THEN
      RETURN '{}'::uuid[];
    END IF;
  END IF;
  v_teams := app.readable_team_ids(p_permission);   -- {} for a guest
  v_member := app.member_team_ids('read');          -- the teams the caller actually sits on (no admin override)
  v_acl := app.acl_grant_ids('channel', p_permission);
  -- A bot inside a run: the conversation channel that run answers in, and only while the run is live. Planned only here, so a database
  -- without the bots plugin never looks for `bot_runs` (nothing there has a run).
  IF v_kind = 'bot' THEN
    v_run := app.run_id();
    IF v_run IS NOT NULL THEN
      SELECT coalesce(array_agg(c.id), '{}'::uuid[]) INTO v_conv
        FROM app.bot_runs r JOIN app.channels c ON c.id = r.channel_id
       WHERE r.id = v_run AND r.bot_id = v_ref AND r.status = 'running' AND r.workspace_id = v_ws
         AND c.workspace_id = v_ws AND c.kind = 'bot_conversation' AND c.bot_id = v_ref
         AND (p_permission = 'read' OR c.archived_at IS NULL);
    END IF;
  END IF;
  RETURN coalesce((
    SELECT array_agg(DISTINCT s.id) FROM (
      SELECT c.id FROM app.channels c
       WHERE c.workspace_id = v_ws AND c.kind = 'channel' AND NOT c.private AND c.team_id = ANY (v_teams)
         AND (p_permission = 'read' OR c.archived_at IS NULL)
      UNION
      SELECT c.id FROM app.channel_members m JOIN app.channels c ON c.id = m.channel_id
       WHERE v_kind = 'person' AND m.person_id = v_ref AND c.workspace_id = v_ws AND v_role <> 'guest'
         AND (c.team_id IS NULL OR c.team_id = ANY (v_member))
         AND (p_permission = 'read' OR c.archived_at IS NULL)
      UNION
      SELECT c.id FROM app.channels c
       WHERE c.workspace_id = v_ws AND c.id = ANY (v_acl) AND (p_permission = 'read' OR c.archived_at IS NULL)
      UNION
      SELECT x FROM unnest(v_conv) AS x
    ) s
  ), '{}'::uuid[]);
END
$$;

-- Nobody leaves a bot conversation: the membership row is what makes the channel the person's (a DM is the same). Everything else of
-- 0001's function is unchanged.
CREATE OR REPLACE FUNCTION app.channels_remove_member(p_channel_id uuid, p_person_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws     uuid := app.workspace_id();
  v_person uuid;
  c        app.channels;
  n        integer;
BEGIN
  SELECT a.ref_id INTO v_person FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = v_ws;
  SELECT * INTO c FROM app.channels WHERE id = p_channel_id AND workspace_id = v_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'you cannot change this channel' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_person IS NOT NULL AND v_person = p_person_id AND app.lookup_workspace_role() IS NOT NULL THEN
    NULL;   -- leaving: one's own row
  ELSIF NOT app.lookup_channel_can(p_channel_id, 'manage') THEN
    RAISE EXCEPTION 'only a team lead or workspace admin may remove members' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF c.kind = 'dm' THEN
    RAISE EXCEPTION 'nobody leaves a direct message' USING ERRCODE = 'check_violation';
  END IF;
  IF c.kind = 'bot_conversation' THEN
    RAISE EXCEPTION 'nobody leaves a conversation with a bot' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM app.channel_members WHERE channel_id = p_channel_id AND person_id = p_person_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;
