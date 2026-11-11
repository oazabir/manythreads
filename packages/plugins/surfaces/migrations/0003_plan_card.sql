-- surfaces 0003: the plan card of a goal (PLAN P22-03, docs/plugins/surfaces.md "The plan card"). Forward-only: never edit once applied.
--
-- A plan card is a surface the PLATFORM writes for a goal (`surface.render {goalId, target: "channel"}`), posted in the goal's own channel (not a thread), one per goal.
-- Two columns tie it to what it is about and to the message that shows it:
--
--   goal_id     the goal (tasks plugin, `app.goals`) the card follows. NULL for every ordinary surface. A unique partial index makes it one card per goal: two runs
--               that ask at the same moment settle on one row (`getOneOrCreate` in the tool), and only the run that made the row posts the message.
--               ON DELETE CASCADE: a card without its goal has nothing to show.
--   message_id  the channel message that carries `meta.surfaceRef`, so the plugin can rewrite the message's text (the line an old client shows) when the goal moves
--               on. NULL until the message is posted, and for every ordinary surface. Set once, by the bot that drew the card, to a message of the same channel that
--               names this very surface and was written by the card's own bot; never changed after.
--
-- What this migration adds on top of 0001's rules, so they hold whoever writes (the bot's tool, a later job, a script with the system role):
--   * a surface with a goal is drawn in a TEAM channel (`kind = 'channel'`) of the goal's team, which is the goal's own channel, at the top level of the channel
--     (no thread), and by a bot of that team. The tool checks the same things first and answers in plain words; this is the backstop.
--   * the goal of a surface never changes;
--   * the text and title of a goal's card are written by the system role only (the card is the platform's statement about the goal: a bot that drew it cannot
--     point it at another goal or put other parts beside it). The bot's own `surface.update` is refused for it in the tool as well.
--   * `message_id` is set once (above) and a person never sets it.
-- Reading is unchanged: whoever can read the channel reads the card (RLS of 0001); what the card SHOWS is read by `tasks.goal` as the person looking.

ALTER TABLE app.surfaces
  ADD COLUMN goal_id    uuid REFERENCES app.goals (id) ON DELETE CASCADE,
  ADD COLUMN message_id uuid REFERENCES app.messages (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX surfaces_goal ON app.surfaces (goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX surfaces_message ON app.surfaces (message_id) WHERE message_id IS NOT NULL;

COMMENT ON COLUMN app.surfaces.goal_id IS 'The goal this surface is the plan card of (one card per goal); null for an ordinary surface. Never changes. Its text and title are written by the system role only.';
COMMENT ON COLUMN app.surfaces.message_id IS 'The channel message that shows this surface (meta.surfaceRef = this id), kept so its text line can follow the goal; set once by the owning bot, null for an ordinary surface.';

-- surfaces_before_insert: 0001's body plus the rules for a goal's card.
CREATE OR REPLACE FUNCTION app.surfaces_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  c app.channels;
  b app.bots;
  g app.goals;
BEGIN
  SELECT * INTO c FROM app.channels WHERE id = NEW.channel_id;
  IF NOT FOUND OR c.workspace_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'a surface belongs to a channel of the same workspace' USING ERRCODE = 'check_violation';
  END IF;
  NEW.team_id := c.team_id;
  SELECT * INTO b FROM app.bots WHERE id = NEW.bot_id;
  IF NOT FOUND OR b.workspace_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'a surface is drawn by a bot of the same workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.thread_root_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.messages m WHERE m.id = NEW.thread_root_id AND m.channel_id = NEW.channel_id) THEN
    RAISE EXCEPTION 'the thread of a surface is a message of its channel' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.goal_id IS NOT NULL THEN
    SELECT * INTO g FROM app.goals WHERE id = NEW.goal_id;
    IF NOT FOUND OR g.workspace_id <> NEW.workspace_id OR g.team_id IS DISTINCT FROM b.team_id THEN
      RAISE EXCEPTION 'the plan card of a goal is drawn by a bot of the goal''s team' USING ERRCODE = 'check_violation';
    END IF;
    IF c.kind <> 'channel' OR c.team_id IS DISTINCT FROM g.team_id OR g.channel_id IS DISTINCT FROM NEW.channel_id THEN
      RAISE EXCEPTION 'the plan card of a goal is drawn in the goal''s own team channel' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.thread_root_id IS NOT NULL THEN
      RAISE EXCEPTION 'the plan card of a goal is drawn in the channel, not in a thread' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF session_user <> 'manythreads_system' THEN
    IF NOT EXISTS (SELECT 1 FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'bot' AND a.ref_id = NEW.bot_id AND a.workspace_id = NEW.workspace_id) THEN
      RAISE EXCEPTION 'only the bot itself draws its surface' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_by := app.actor();
    NEW.run_id := app.run_id();
    NEW.version := 1;
    NEW.pinned_channel_id := NULL;
    NEW.pinned_by := NULL;
    NEW.pinned_at := NULL;
    -- the message is tied afterwards, once it exists
    NEW.message_id := NULL;
    NEW.created_at := now();
    NEW.updated_at := now();
  END IF;
  IF NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.bot_runs r WHERE r.id = NEW.run_id AND r.bot_id = NEW.bot_id) THEN
    RAISE EXCEPTION 'the run of a surface is a run of its bot' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- surfaces_guard: 0001's body plus the rules for goal_id, message_id and a goal card's text.
CREATE OR REPLACE FUNCTION app.surfaces_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_system boolean := session_user = 'manythreads_system';
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.channel_id <> OLD.channel_id
     OR NEW.bot_id <> OLD.bot_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR NEW.goal_id IS DISTINCT FROM OLD.goal_id THEN
    RAISE EXCEPTION 'a surface keeps its place and its bot' USING ERRCODE = 'check_violation';
  END IF;
  -- the message that shows a surface is tied once, to a message of the same channel that names this surface and was written by the card's own bot
  IF NEW.message_id IS DISTINCT FROM OLD.message_id THEN
    IF OLD.message_id IS NOT NULL OR NEW.message_id IS NULL THEN
      RAISE EXCEPTION 'the message of a surface is set once and does not change' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.messages m
                    WHERE m.id = NEW.message_id AND m.channel_id = NEW.channel_id AND m.author_id = NEW.created_by
                      AND m.meta ->> 'surfaceRef' = NEW.id::text) THEN
      RAISE EXCEPTION 'the message of a surface is a message of its channel that shows this surface' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT v_system THEN
    IF OLD.goal_id IS NOT NULL AND (NEW.title <> OLD.title OR NEW.source <> OLD.source OR NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id) THEN
      RAISE EXCEPTION 'the plan card of a goal is written by the platform only' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF app.actor() = OLD.created_by THEN
      IF NEW.pinned_channel_id IS DISTINCT FROM OLD.pinned_channel_id OR NEW.pinned_by IS DISTINCT FROM OLD.pinned_by OR NEW.pinned_at IS DISTINCT FROM OLD.pinned_at THEN
        RAISE EXCEPTION 'a bot does not pin its own surface' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id AND NEW.thread_root_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM app.messages m WHERE m.id = NEW.thread_root_id AND m.channel_id = NEW.channel_id) THEN
        RAISE EXCEPTION 'the thread of a surface is a message of its channel' USING ERRCODE = 'check_violation';
      END IF;
      NEW.run_id := coalesce(app.run_id(), OLD.run_id);
    ELSE
      IF (SELECT app.person_id()) IS NULL THEN
        RAISE EXCEPTION 'only the bot that drew a surface changes it' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NEW.title <> OLD.title OR NEW.source <> OLD.source OR NEW.version <> OLD.version OR NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id
         OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.message_id IS DISTINCT FROM OLD.message_id THEN
        RAISE EXCEPTION 'a person changes only the pin of a surface' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.pinned_channel_id IS NULL THEN
        NEW.pinned_by := NULL;
        NEW.pinned_at := NULL;
      ELSIF OLD.pinned_channel_id IS NULL THEN
        NEW.pinned_by := app.actor();
        NEW.pinned_at := now();
      ELSE
        NEW.pinned_by := OLD.pinned_by;
        NEW.pinned_at := OLD.pinned_at;
      END IF;
    END IF;
  END IF;
  IF NEW.source IS DISTINCT FROM OLD.source THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- as in 0001: the replaced functions keep the system role as their owner, so they pass the system policies (and only those)
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.surfaces_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.surfaces_guard() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
