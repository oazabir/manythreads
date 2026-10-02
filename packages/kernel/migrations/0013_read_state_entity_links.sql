-- 0013_read_state_entity_links (P3-03, P3-04): the read-state table and its bump function, and the type rules of entity_links.
-- Forward-only: never edit this file once applied.

-- read_state (P) ---------------------------------------------------------------------------------------------------------------
-- One row per person per channel or thread (PLAN A.3). `target_id` is a channel id or a thread id (the root message id); the
-- kernel does not own channels or messages, so it holds no foreign key to them. `last_read_id` is a message id: uuid v7 sorts by
-- time, so "newer than" is `id > last_read_id`. `unread_count` is kept by the service (bump on post, absolute set on mark-read).
CREATE TABLE app.read_state (
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  target_type  text NOT NULL CHECK (target_type IN ('channel', 'thread')),
  target_id    uuid NOT NULL,
  last_read_id uuid,
  unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  followed     boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, target_type, target_id)
);
-- The hot filter: "what is unread for me". INCLUDE makes the unread summary an index-only scan. (person_id is the leading column of
-- the primary key, which indexes the foreign key.)
CREATE INDEX read_state_unread ON app.read_state (person_id, target_id) INCLUDE (target_type, unread_count) WHERE unread_count > 0;

ALTER TABLE app.read_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.read_state FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE app.read_state IS 'rls: person — P: a person reads and writes only their own rows; other people''s counters are bumped by app.read_state_bump().';

-- `app.person_id()` is the caller's people id (NULL for a bot or no actor), wrapped so it is evaluated once per statement.
CREATE POLICY read_state_select ON app.read_state FOR SELECT
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY read_state_insert ON app.read_state FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY read_state_update ON app.read_state FOR UPDATE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY read_state_delete ON app.read_state FOR DELETE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON app.read_state TO manythreads_app;

-- app.read_state_bump: the one door through which someone else's counter moves -------------------------------------------------
-- A post must raise the unread count of every recipient except its author, but RLS lets a person write only their own row. This
-- SECURITY DEFINER function (owned by manythreads_system, pinned search_path) does that in ONE statement for the whole recipient
-- list. What it checks, because inside it app.is_system() is always true (MISTAKES: P2 review):
--   * the caller is an actor of the workspace (a person who is still an active member, or a bot), or the system pool itself
--     (session_user, which SET ROLE and definer ownership do not change);
--   * recipients are active people who are members of the caller's workspace: anything else is ignored, so a caller cannot touch
--     another workspace;
--   * the author is skipped (given as an actor id or a person id);
--   * a message that is not newer than the recipient's read position does not count (a replayed or out-of-order post is a no-op).
-- It only ever adds 1 and returns the new state of the rows it changed (for the event and the live push).
-- The caller (the channels or threads plugin) decides who the recipients are: channel members, thread followers.
CREATE FUNCTION app.read_state_bump(
  p_target_type text, p_target_id uuid, p_message_id uuid, p_author uuid, p_recipients uuid[]
) RETURNS TABLE (person_id uuid, last_read_id uuid, unread_count integer, followed boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws    uuid := app.workspace_id();
  v_actor uuid := app.actor();
  v_kind  text;
BEGIN
  IF p_recipients IS NULL OR cardinality(p_recipients) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_recipients) > 10000 THEN
    RAISE EXCEPTION 'read_state_bump: at most 10000 recipients per call' USING ERRCODE = 'program_limit_exceeded';
  END IF;
  IF session_user <> 'manythreads_system' THEN
    SELECT a.kind INTO v_kind FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
    IF v_kind IS NULL OR v_kind = 'system' OR (v_kind = 'person' AND app.lookup_workspace_role() IS NULL) THEN
      RAISE EXCEPTION 'read_state_bump: the caller is not an actor of this workspace' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN QUERY
  INSERT INTO app.read_state AS rs (person_id, target_type, target_id, unread_count)
  SELECT p.id, p_target_type, p_target_id, 1
  FROM app.people p
  JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id
  WHERE p.id = ANY (p_recipients)
    AND p.workspace_id = v_ws
    AND p.status = 'active'
    AND p.id IS DISTINCT FROM p_author
    AND p.id IS DISTINCT FROM (SELECT a.ref_id FROM app.actors a WHERE a.id = p_author AND a.kind = 'person' AND a.workspace_id = v_ws)
  ON CONFLICT (person_id, target_type, target_id) DO UPDATE
    SET unread_count = rs.unread_count + 1, updated_at = now()
    WHERE rs.last_read_id IS NULL OR rs.last_read_id < p_message_id
  RETURNING rs.person_id, rs.last_read_id, rs.unread_count, rs.followed;
END
$$;

REVOKE ALL ON FUNCTION app.read_state_bump(text, uuid, uuid, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_state_bump(text, uuid, uuid, uuid, uuid[]) TO manythreads_app, manythreads_system;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.read_state_bump(text, uuid, uuid, uuid, uuid[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

-- entity_links: type and kind rules ---------------------------------------------------------------------------------------------
-- The table (0001) and its policy (0011: members of the team, read and write) stay as they are. Added: the entity types the
-- service links (the same list as the EntityType enum in packages/shared) and the shape of `kind`. Adding a type later is a
-- forward-only migration that replaces the CHECK.
ALTER TABLE app.entity_links
  ADD CONSTRAINT entity_links_src_type_check CHECK (src_type IN ('message', 'thread', 'task', 'page', 'bot', 'file')),
  ADD CONSTRAINT entity_links_dst_type_check CHECK (dst_type IN ('message', 'thread', 'task', 'page', 'bot', 'file')),
  ADD CONSTRAINT entity_links_kind_check CHECK (kind ~ '^[a-z][a-z0-9_]{0,39}$');
