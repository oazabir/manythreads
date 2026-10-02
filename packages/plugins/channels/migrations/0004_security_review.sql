-- channels 0004: Phase 3 security review fixes. Forward-only: never edit once applied.
--
-- 1. A private channel of a team needs the team. 0001 gave a `channel_members` row access to a private team channel without asking
--    whether the person still sits on the team, so removing someone from a team left them reading (and receiving live pushes of) its
--    private channels. The membership row stays (re-adding the person to the team brings it back), but it only counts while the person is
--    on the channel's team. A DM has no team and is unaffected. The same rule goes into channel_audience, which a test compares with the
--    visible set for every persona.
--
-- 2. A thread's title is a copy of its root's first 120 characters, taken when the first reply arrived. Deleting or editing the root
--    left the old text in `threads.title`, which the Threads inbox, thread search and the link resolver then served: the text of a
--    deleted message stayed readable. A trigger now keeps the title in step with the root, and existing rows are repaired below.

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
    ) s
  ), '{}'::uuid[]);
END
$$;

CREATE OR REPLACE FUNCTION app.channel_audience(p_channel_id uuid) RETURNS TABLE (person_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws uuid := app.workspace_id();
BEGIN
  IF session_user <> 'manythreads_system' AND NOT app.lookup_channel_can(p_channel_id, 'read') THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT DISTINCT p.id
  FROM app.channels c
  JOIN app.people p ON p.workspace_id = c.workspace_id AND p.status = 'active'
  JOIN app.workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.person_id = p.id
  WHERE c.id = p_channel_id AND c.workspace_id = v_ws
    AND (
      (c.kind = 'channel' AND NOT c.private AND wm.role <> 'guest' AND (
         wm.role IN ('owner', 'admin')
         OR EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                     WHERE tm.team_id = c.team_id AND a.ref_id = p.id)))
      OR (wm.role <> 'guest'
          AND EXISTS (SELECT 1 FROM app.channel_members m WHERE m.channel_id = c.id AND m.person_id = p.id)
          AND (c.team_id IS NULL
               OR EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                           WHERE tm.team_id = c.team_id AND a.ref_id = p.id)))
      OR EXISTS (
        SELECT 1 FROM app.acl_entries e
         WHERE e.workspace_id = c.workspace_id AND e.resource_type = 'channel' AND e.resource_id = c.id
           AND (
             (e.subject_type = 'person' AND e.subject_id = p.id)
             OR (e.subject_type = 'team' AND wm.role <> 'guest' AND EXISTS (
                   SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                    WHERE tm.team_id = e.subject_id AND a.ref_id = p.id))
             OR (e.subject_type = 'role' AND EXISTS (
                   SELECT 1 FROM app.role_members rm WHERE rm.role_id = e.subject_id AND rm.person_id = p.id))
           ))
    );
END
$$;

-- Thread titles follow their root --------------------------------------------------------------------------------------------------
CREATE FUNCTION app.messages_after_update_title() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.threads SET title = CASE WHEN NEW.deleted_at IS NOT NULL THEN '[deleted]' ELSE left(NEW.body_plain, 120) END
   WHERE root_message_id = NEW.id;
  RETURN NULL;
END
$$;
CREATE TRIGGER messages_after_update_title AFTER UPDATE OF body_plain, deleted_at ON app.messages FOR EACH ROW
  WHEN (NEW.thread_root_id IS NULL AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.body_plain IS DISTINCT FROM OLD.body_plain))
  EXECUTE FUNCTION app.messages_after_update_title();

-- Repair what the old behaviour left behind (deleted or edited roots of existing threads).
UPDATE app.threads t SET title = CASE WHEN m.deleted_at IS NOT NULL THEN '[deleted]' ELSE left(m.body_plain, 120) END
  FROM app.messages m
 WHERE m.id = t.root_message_id AND (m.deleted_at IS NOT NULL OR m.edited_at IS NOT NULL)
   AND t.title IS DISTINCT FROM CASE WHEN m.deleted_at IS NOT NULL THEN '[deleted]' ELSE left(m.body_plain, 120) END;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.messages_after_update_title() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
