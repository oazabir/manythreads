-- channels 0003: mentions are rewritten on edit, following a thread is mirrored into the read state and no longer undone by a reply,
-- and the ephemeral tables presence and typing (PLAN.md A.3, P3-06, P3-07). Forward-only: never edit once applied.

-- message_mentions: an edit rewrites the rows ------------------------------------------------------------------------------------
-- 0002 let the app role insert mentions only; editing a message removes the ones its new text no longer holds. Only the author
-- of the message deletes (the same rule the insert trigger applies), on a channel they can still post in.
CREATE POLICY message_mentions_delete ON app.message_mentions FOR DELETE
  USING ((SELECT app.is_system()) OR (
    channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])
    AND EXISTS (SELECT 1 FROM app.messages m WHERE m.id = message_mentions.message_id AND m.author_id = (SELECT app.actor()))));
GRANT DELETE ON app.message_mentions TO manythreads_app;

-- Who a `@handle` can mean ---------------------------------------------------------------------------------------------------------
-- The people of a channel's audience (those who can read it now) who are active and have an actor row (the id message_mentions stores),
-- narrowed to the ones whose display name or email starts with one of the prefixes. `actors` shows a caller only their own row, so the
-- lookup is a definer function (owned by manythreads_system; it checks the caller itself, never app.is_system()). Only for a caller who
-- can read the channel; a guest sees no member list, so a guest resolves nobody. At most 200 candidates.
CREATE FUNCTION app.channel_mention_candidates(p_channel_id uuid, p_prefixes text[])
  RETURNS TABLE (person_id uuid, actor_id uuid, display_name text, primary_email text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_prefixes IS NULL OR cardinality(p_prefixes) = 0 THEN
    RETURN;
  END IF;
  IF session_user <> 'manythreads_system' AND (
       NOT coalesce(app.lookup_channel_can(p_channel_id, 'read'), false)
       OR coalesce(app.lookup_workspace_role(), 'guest') = 'guest') THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT p.id, a.id, p.display_name, p.primary_email
    FROM app.channel_audience(p_channel_id) au
    JOIN app.people p ON p.id = au.person_id AND p.status = 'active'
    JOIN app.actors a ON a.kind = 'person' AND a.ref_id = p.id AND a.workspace_id = p.workspace_id
   WHERE lower(p.display_name) LIKE ANY (p_prefixes) OR lower(p.primary_email) LIKE ANY (p_prefixes)
   LIMIT 200;
END
$$;
REVOKE ALL ON FUNCTION app.channel_mention_candidates(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.channel_mention_candidates(uuid, text[]) TO manythreads_app, manythreads_system;

-- Following a thread ---------------------------------------------------------------------------------------------------------------
-- ONE source of truth: `thread_follows` is the membership of a thread (who gets its reply counts, who the Threads inbox lists).
-- `read_state.followed` is only a mirror of it for the read-state API and pushes, kept by this trigger so that every path agrees,
-- including the automatic follow of a reply, which writes the root author's follow while someone else is the caller (and RLS lets
-- a person write only their own read_state row). The follow and unfollow routes call ctx.readState.setFollowed first (it announces
-- the change), then write thread_follows; by then the mirror already says the same and the trigger writes nothing.
CREATE FUNCTION app.thread_follows_mirror() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.read_state AS rs (person_id, target_type, target_id, followed)
    VALUES (NEW.person_id, 'thread', NEW.thread_root_id, true)
    ON CONFLICT (person_id, target_type, target_id) DO UPDATE SET followed = true, updated_at = now() WHERE NOT rs.followed;
    RETURN NEW;
  END IF;
  UPDATE app.read_state SET followed = false, updated_at = now()
   WHERE person_id = OLD.person_id AND target_type = 'thread' AND target_id = OLD.thread_root_id AND followed;
  RETURN OLD;
END
$$;
CREATE TRIGGER thread_follows_mirror AFTER INSERT OR DELETE ON app.thread_follows
  FOR EACH ROW EXECUTE FUNCTION app.thread_follows_mirror();

-- 0002 made the root's author follow on EVERY reply, so unfollowing a thread you started was undone by the next reply. Now the root's
-- author follows when the thread is created (the first reply); the replier follows on each of their own replies (replying follows).
CREATE OR REPLACE FUNCTION app.messages_after_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_first boolean;
  v_root_author uuid;
BEGIN
  INSERT INTO app.threads (root_message_id, channel_id, title, reply_count, last_reply_at)
  SELECT m.id, m.channel_id, left(m.body_plain, 120), 1, NEW.created_at FROM app.messages m WHERE m.id = NEW.thread_root_id
  ON CONFLICT (root_message_id) DO UPDATE
    SET reply_count = app.threads.reply_count + 1, last_reply_at = greatest(app.threads.last_reply_at, EXCLUDED.last_reply_at)
  RETURNING (xmax = 0) INTO v_first;
  SELECT m.author_id INTO v_root_author FROM app.messages m WHERE m.id = NEW.thread_root_id;
  -- A bot has no follows.
  INSERT INTO app.thread_follows (person_id, thread_root_id)
  SELECT DISTINCT a.ref_id, NEW.thread_root_id FROM app.actors a
   WHERE a.kind = 'person' AND a.workspace_id = NEW.workspace_id
     AND (a.id = NEW.author_id OR (coalesce(v_first, false) AND a.id = v_root_author))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;

-- presence (WR) --------------------------------------------------------------------------------------------------------------------
-- One row per person: the last heartbeat. UNLOGGED (it is gone after a crash and nobody minds); a row older than PRESENCE_TTL_SECONDS
-- (90, see shared) is "offline", so nothing needs to delete it: readers filter by seen_at.
CREATE UNLOGGED TABLE app.presence (
  person_id    uuid PRIMARY KEY REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'away')),
  seen_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX presence_workspace_seen ON app.presence (workspace_id, seen_at DESC);
COMMENT ON TABLE app.presence IS 'rls: workspace — WR: UNLOGGED heartbeat per person; members read everyone of the workspace, a guest only themself; a person writes only their own row.';

-- typing (C) -----------------------------------------------------------------------------------------------------------------------
-- Who is typing where, for TYPING_TTL_SECONDS (5): the row says until when. UNLOGGED. Readers filter by expires_at; every typing
-- request also deletes the expired rows of its channel, so the table stays as small as the people typing right now.
CREATE UNLOGGED TABLE app.typing (
  channel_id uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (channel_id, person_id)
);
CREATE INDEX typing_person ON app.typing (person_id);
COMMENT ON TABLE app.typing IS 'rls: team — C: UNLOGGED "is typing" rows of the channels the caller can read; a person writes only their own row, in a channel they can post in.';

ALTER TABLE app.presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.presence FORCE ROW LEVEL SECURITY;
CREATE POLICY presence_select ON app.presence FOR SELECT USING (
  (SELECT app.is_system())
  OR person_id = (SELECT app.person_id())
  OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin', 'member')));
CREATE POLICY presence_insert ON app.presence FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY presence_update ON app.presence FOR UPDATE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system()) OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())));
CREATE POLICY presence_delete ON app.presence FOR DELETE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));

ALTER TABLE app.typing ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.typing FORCE ROW LEVEL SECURITY;
CREATE POLICY typing_select ON app.typing FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY typing_insert ON app.typing FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (person_id = (SELECT app.person_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])));
CREATE POLICY typing_update ON app.typing FOR UPDATE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system())
    OR (person_id = (SELECT app.person_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])));
-- A person deletes their own row (sending the message); anyone who can read the channel sweeps rows that have expired.
CREATE POLICY typing_delete ON app.typing FOR DELETE USING (
  (SELECT app.is_system()) OR person_id = (SELECT app.person_id())
  OR (expires_at < now() AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])));

GRANT SELECT, INSERT, UPDATE, DELETE ON app.presence TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.typing TO manythreads_app;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.channel_mention_candidates(uuid, text[]) OWNER TO manythreads_system;
ALTER FUNCTION app.thread_follows_mirror() OWNER TO manythreads_system;
ALTER FUNCTION app.messages_after_insert() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
