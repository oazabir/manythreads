-- surfaces 0001: bot-drawn screens and their history (PLAN P9-01, SPEC §14). Forward-only: never edit once applied.
--
-- A surface is a screen a bot wrote in OpenUI Lang: the text it wrote (`source`), a version number that goes up by one every time that text changes, and the
-- place it was drawn: a channel (a bot conversation is a channel too), optionally the thread of one message. Two tables:
--
--   surfaces        the current state of each surface. One row per surface.
--   surface_events  what happened to it, one line each, written once and never changed: the first draw, a patch of some nodes, a click or a form sent back to
--                   the bot, a pin, a save as a page, a node the checker refused.
--
-- WHO READS: whoever can read the surface's channel (app.visible_channel_ids), exactly like a message in it. A private channel's surface is never visible
-- to anyone who cannot read that channel, an admin included. The text is data, not trusted code: the viewer's checker (packages/shared/src/surfaces) draws only
-- registered parts with props that pass their schema; nothing here executes it.
--
-- WHO WRITES: only a bot draws or changes a surface, and only as itself (`created_by` is its own actor, `bot_id` is its own bot, `run_id` is the run it is
-- inside; the trigger fills those and refuses a mismatch). The system role (the plugin's jobs) may do anything. A person may pin or unpin a surface they can post
-- next to, and may write `event` lines (their clicks and forms), `pinned`, `unpinned` and `exported` lines, as themself.
--
-- PIN: today a surface can be pinned only to the channel it was drawn in (CHECK below), so pinning never widens who can read it. Pinning to another channel
-- would, so it waits for an owner decision (P9-09).

CREATE TABLE app.surfaces (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- the channel's team; null in a direct message. Copied by the trigger, never chosen by the caller.
  team_id           uuid REFERENCES app.teams (id) ON DELETE CASCADE,
  channel_id        uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  bot_id            uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  -- the latest run that drew or changed it; null when that run's record has gone
  run_id            uuid REFERENCES app.bot_runs (id) ON DELETE SET NULL,
  -- the root message of the thread it was drawn in; null for a surface drawn in the channel itself
  thread_root_id    uuid REFERENCES app.messages (id) ON DELETE SET NULL,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'),
  source            text NOT NULL CHECK (char_length(source) <= 200000),
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  pinned_channel_id uuid REFERENCES app.channels (id) ON DELETE CASCADE,
  pinned_by         uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  pinned_at         timestamptz,
  created_by        uuid NOT NULL REFERENCES app.actors (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT surfaces_pin_own_channel CHECK (pinned_channel_id IS NULL OR pinned_channel_id = channel_id),
  CONSTRAINT surfaces_pin_shape CHECK ((pinned_channel_id IS NULL) = (pinned_at IS NULL)),
  -- what the history table points at, so an event can carry its surface's place without a trigger
  CONSTRAINT surfaces_place UNIQUE (id, workspace_id, channel_id)
);
CREATE INDEX surfaces_channel ON app.surfaces (channel_id, created_at DESC);
CREATE INDEX surfaces_workspace ON app.surfaces (workspace_id);
CREATE INDEX surfaces_team ON app.surfaces (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX surfaces_bot ON app.surfaces (bot_id);
CREATE INDEX surfaces_run ON app.surfaces (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX surfaces_thread ON app.surfaces (thread_root_id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX surfaces_pinned ON app.surfaces (pinned_channel_id) WHERE pinned_channel_id IS NOT NULL;
CREATE INDEX surfaces_pinned_by ON app.surfaces (pinned_by) WHERE pinned_by IS NOT NULL;
CREATE INDEX surfaces_created_by ON app.surfaces (created_by);
COMMENT ON TABLE app.surfaces IS 'rls: team — C: surfaces of the channels the caller can read (app.visible_channel_ids); drawn and changed only by the bot that owns them (as itself) or the system role; a person who can post in the channel may pin or unpin one.';

CREATE TABLE app.surface_events (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  surface_id   uuid NOT NULL,
  -- the surface's place, held by the composite foreign key below, so a policy can probe the visibility set without reading the surface
  workspace_id uuid NOT NULL,
  channel_id   uuid NOT NULL,
  actor_id     uuid NOT NULL REFERENCES app.actors (id),
  kind         text NOT NULL CHECK (kind IN ('render', 'update', 'event', 'rejected', 'pinned', 'unpinned', 'exported')),
  -- the surface's version when this happened
  version      integer NOT NULL CHECK (version >= 1),
  -- the node it is about (the patch target, the button clicked); null when it is about the whole surface
  node_id      text CHECK (node_id IS NULL OR char_length(node_id) BETWEEN 1 AND 64),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT surface_events_surface FOREIGN KEY (surface_id, workspace_id, channel_id) REFERENCES app.surfaces (id, workspace_id, channel_id) ON DELETE CASCADE,
  CONSTRAINT surface_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT surface_events_payload_size CHECK (char_length(payload::text) <= 65536)
);
CREATE INDEX surface_events_surface ON app.surface_events (surface_id, id);
CREATE INDEX surface_events_channel ON app.surface_events (channel_id);
CREATE INDEX surface_events_workspace ON app.surface_events (workspace_id);
CREATE INDEX surface_events_actor ON app.surface_events (actor_id);
CREATE INDEX surface_events_created_brin ON app.surface_events USING brin (created_at);
COMMENT ON TABLE app.surface_events IS 'rls: team — C: history of a surface, readable by whoever can read its channel; append-only. A bot writes render, update and rejected lines for its own surface; a person writes event, pinned, unpinned and exported lines as themself and only where they can post.';

-- surfaces: what a new row must be, whoever inserts it. The place comes from the channel; the bot must exist in the workspace; a thread root must be a message of the
-- channel; a run must be the bot's own. A caller that is not the system role is the bot itself: its actor, its bot, its run.
CREATE FUNCTION app.surfaces_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  c app.channels;
  b app.bots;
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
    NEW.created_at := now();
    NEW.updated_at := now();
  END IF;
  IF NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.bot_runs r WHERE r.id = NEW.run_id AND r.bot_id = NEW.bot_id) THEN
    RAISE EXCEPTION 'the run of a surface is a run of its bot' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER surfaces_before_insert BEFORE INSERT ON app.surfaces FOR EACH ROW EXECUTE FUNCTION app.surfaces_before_insert();

-- surfaces: what an update may change. The place and the author never change. The owning bot changes the title, the source and the thread; a change of source
-- raises the version by exactly one (nobody chooses a version). A person who can post in the channel changes only the pin, and pins as themself. The system role
-- may change what it needs, but the version rule holds for it too.
CREATE FUNCTION app.surfaces_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_system boolean := session_user = 'manythreads_system';
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.channel_id <> OLD.channel_id
     OR NEW.bot_id <> OLD.bot_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a surface keeps its place and its bot' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_system THEN
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
         OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
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
CREATE TRIGGER surfaces_guard BEFORE UPDATE ON app.surfaces FOR EACH ROW EXECUTE FUNCTION app.surfaces_guard();

-- surface_events: a line is about the surface's current version unless the writer says the version it saw (a click on an older draw is recorded as that
-- version), never a version that does not exist yet. Only a bot writes bot lines, only for its own surface.
CREATE FUNCTION app.surface_events_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  s app.surfaces;
BEGIN
  SELECT * INTO s FROM app.surfaces WHERE id = NEW.surface_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such surface' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.version > s.version THEN
    RAISE EXCEPTION 'this surface has no such version yet' USING ERRCODE = 'check_violation';
  END IF;
  IF session_user <> 'manythreads_system' THEN
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER surface_events_before_insert BEFORE INSERT ON app.surface_events FOR EACH ROW EXECUTE FUNCTION app.surface_events_before_insert();

-- Row level security ---------------------------------------------------------------------------------------------------------------
ALTER TABLE app.surfaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.surfaces FORCE ROW LEVEL SECURITY;
CREATE POLICY surfaces_select ON app.surfaces FOR SELECT USING (
  (SELECT app.is_system())
  OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
-- The bot draws as itself, into a channel it may post in. The trigger checks that the actor is the bot named in the row.
CREATE POLICY surfaces_insert ON app.surfaces FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND created_by = (SELECT app.actor())
      AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])));
-- Changing one needs the right to post in its channel; the trigger says which columns the caller may touch.
CREATE POLICY surfaces_update ON app.surfaces FOR UPDATE
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])));
CREATE POLICY surfaces_delete ON app.surfaces FOR DELETE USING ((SELECT app.is_system()));

ALTER TABLE app.surface_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.surface_events FORCE ROW LEVEL SECURITY;
CREATE POLICY surface_events_select ON app.surface_events FOR SELECT USING (
  (SELECT app.is_system())
  OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY surface_events_insert ON app.surface_events FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND actor_id = (SELECT app.actor())
      AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])
      AND (
        (kind IN ('event', 'pinned', 'unpinned', 'exported') AND (SELECT app.person_id()) IS NOT NULL)
        OR (kind IN ('render', 'update', 'rejected')
            AND EXISTS (SELECT 1 FROM app.surfaces s WHERE s.id = surface_events.surface_id AND s.created_by = surface_events.actor_id)))));
CREATE POLICY surface_events_delete ON app.surface_events FOR DELETE USING ((SELECT app.is_system()));

GRANT SELECT, INSERT, UPDATE ON app.surfaces TO manythreads_app;
GRANT SELECT, INSERT ON app.surface_events TO manythreads_app;

-- The definer functions run as the system role, so they pass the system policies above (and only those).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.surfaces_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.surfaces_guard() OWNER TO manythreads_system;
ALTER FUNCTION app.surface_events_before_insert() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
