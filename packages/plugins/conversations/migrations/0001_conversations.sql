-- conversations 0001: talking to a bot (PLAN P5-16, SPEC §6.2). Forward-only: never edit once applied.
--
--  * app.conversations_open(bot): the one door that makes the caller's conversation channel with a bot. A conversation is an ordinary
--    thread; it lives in a channel of kind 'bot_conversation' that the sidebar never lists. There is ONE per (bot, person), private to
--    that person: the channel's only member is the asker, so every rule that follows a channel's visibility (messages, threads,
--    reactions, search, read state, notifications, the Threads inbox) keeps one person's conversation from another's with no rule of
--    its own, and a workspace admin who is not the asker reads nothing (as with a DM). The bot answers in it through its run
--    (channels 0006). The channels policy never lets a caller insert such a channel, so this SECURITY DEFINER function, owned by
--    manythreads_system, does it. Inside it app.is_system() is always true (MISTAKES P2 review): the caller is checked with the
--    lookup_* helpers and the actor row, never the is_* helpers.
--
--  * app.conversations: the index of those threads, one row per conversation, keyed by the thread's root message. It exists so that a
--    conversation has a place to say who may find it: `visibility` is `private` (the asker only) or `shared` (the bot's team lists it
--    under Shared; P5-17 sets it and records where it was posted). The row holds NO text: titles and previews are read from the
--    messages with the reader's own visibility, so editing or deleting a message can never leave a stale copy on an index row.
--    Rows are written by the system (the subscriber that indexes a first message, P5-17's sharing door); callers only read.

-- One conversation channel per (bot, person): the asker is the channel's creator. A partial unique index like a DM's `dm_key`.
CREATE UNIQUE INDEX channels_bot_conversation ON app.channels (workspace_id, bot_id, created_by) WHERE kind = 'bot_conversation';

CREATE FUNCTION app.conversations_open(p_bot_id uuid) RETURNS TABLE (channel_id uuid, created boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws      uuid := app.workspace_id();
  v_role    text := app.lookup_workspace_role();
  v_me      uuid;
  v_team    uuid;
  v_status  text;
  v_new     uuid := uuidv7();
  v_channel uuid;
BEGIN
  SELECT a.ref_id INTO v_me FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = v_ws;
  -- A guest's reach is the channels they were granted, and a bot does not talk to a bot: neither opens a conversation.
  IF v_me IS NULL OR v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'only members of the workspace can talk to a bot' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT b.team_id, b.status INTO v_team, v_status FROM app.bots b WHERE b.id = p_bot_id AND b.workspace_id = v_ws;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such bot' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The run that answers is opened for a person of the bot's team (ctx.runs.open refuses anybody else), so only they may start one.
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

REVOKE ALL ON FUNCTION app.conversations_open(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.conversations_open(uuid) TO manythreads_app, manythreads_system;

-- The index ----------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.conversations (
  thread_root_id uuid PRIMARY KEY REFERENCES app.messages (id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  -- the index goes with the bot's row; the messages stay (they are the person's, in their own channel)
  bot_id         uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  person_id      uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  channel_id     uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  visibility     text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  -- where P5-17 posted the shared copy and the thread it made there; no foreign key on the thread (a deleted copy must not delete the index)
  shared_to      uuid REFERENCES app.channels (id) ON DELETE SET NULL,
  shared_root_id uuid,
  shared_by      uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  shared_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_shared_shape CHECK ((visibility = 'shared') = (shared_at IS NOT NULL)),
  CONSTRAINT conversations_share_target CHECK (visibility = 'shared' OR (shared_to IS NULL AND shared_root_id IS NULL))
);
-- the lists: a person's own, newest thread first; the team's shared ones
CREATE INDEX conversations_person ON app.conversations (bot_id, person_id, thread_root_id DESC);
CREATE INDEX conversations_shared ON app.conversations (bot_id, thread_root_id DESC) WHERE visibility = 'shared';
CREATE INDEX conversations_channel ON app.conversations (channel_id);
CREATE INDEX conversations_person_id ON app.conversations (person_id);
CREATE INDEX conversations_team ON app.conversations (team_id);
CREATE INDEX conversations_workspace ON app.conversations (workspace_id);
CREATE INDEX conversations_shared_to ON app.conversations (shared_to) WHERE shared_to IS NOT NULL;
CREATE INDEX conversations_shared_by ON app.conversations (shared_by) WHERE shared_by IS NOT NULL;
COMMENT ON TABLE app.conversations IS 'rls: person — P: the index of a bot''s conversations; the asker reads their own, the bot''s team reads the shared ones; written by the system role only (the indexing subscriber, P5-17''s sharing door). Holds no message text.';

ALTER TABLE app.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.conversations FORCE ROW LEVEL SECURITY;
-- Hoisted sets (one evaluation per statement): the asker's own rows, and the shared rows of the teams the caller may read. A private row of
-- somebody else is invisible to everybody, a workspace admin included.
CREATE POLICY conversations_select ON app.conversations FOR SELECT USING (
  (SELECT app.is_system())
  OR person_id = (SELECT app.person_id())
  OR (visibility = 'shared' AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))
);
CREATE POLICY conversations_system ON app.conversations FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.conversations TO manythreads_app;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.conversations_open(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
