-- tasks plugin 0008: private notes get an owner, a lifetime and a stricter reader (review of 0007). Forward-only: 0007 stays as applied.
--
--  * A secret may be attached to a handover only if it was sealed through the tasks door for THAT caller: app.handoff_secret_tickets records
--    "this secret was sealed for this actor" (written by the system right after it seals, consumed by app.tasks_set_private_note). Any other
--    secret of the workspace (a model key, a sign-in secret) is refused, so it can never be read back through tasks.private_note.
--  * A ticket nobody consumed (the handover rolled back) and a note that outlived its card are deleted: when the card is done, and by a sweep.
--  * app.tasks_private_note_secret answers only for the NEWEST applied handover of the card (ordered by created_at, then id), only to the bot
--    that handover gave the card to, and only while that bot owns the card and the card is not done.

CREATE TABLE app.handoff_secret_tickets (
  secret_id    uuid PRIMARY KEY REFERENCES app.secrets (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  actor_id     uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handoff_secret_tickets_workspace ON app.handoff_secret_tickets (workspace_id);
CREATE INDEX handoff_secret_tickets_actor ON app.handoff_secret_tickets (actor_id);
CREATE INDEX handoff_secret_tickets_created ON app.handoff_secret_tickets USING brin (created_at);
COMMENT ON TABLE app.handoff_secret_tickets IS 'rls: system — S: which sealed secret the tasks door made for which actor, until it is attached to a handover.';
ALTER TABLE app.handoff_secret_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.handoff_secret_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY handoff_secret_tickets_system ON app.handoff_secret_tickets FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.handoff_secret_tickets TO manythreads_system;

-- The system, right after it sealed a note for `p_actor`. System role only.
CREATE FUNCTION app.tasks_ticket_private_note(p_secret_id uuid, p_actor uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF current_user <> 'manythreads_system' THEN RAISE EXCEPTION 'system only' USING ERRCODE = '42501'; END IF;
  INSERT INTO app.handoff_secret_tickets (secret_id, workspace_id, actor_id)
  SELECT s.id, a.workspace_id, a.id FROM app.secrets s, app.actors a WHERE s.id = p_secret_id AND a.id = p_actor;
END
$$;

CREATE OR REPLACE FUNCTION app.tasks_set_private_note(p_handoff_id uuid, p_secret_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM 1 FROM app.handoff_secret_tickets k
   WHERE k.secret_id = p_secret_id AND k.actor_id = app.actor()
     AND EXISTS (SELECT 1 FROM app.handoffs h JOIN app.tasks t ON t.id = h.task_id
                  WHERE h.id = p_handoff_id AND h.from_actor_id = app.actor() AND h.private_note_secret_id IS NULL AND t.workspace_id = k.workspace_id)
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.handoffs SET private_note_secret_id = p_secret_id WHERE id = p_handoff_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM app.handoff_secret_tickets WHERE secret_id = p_secret_id;
  RETURN v_n = 1;
END
$$;

CREATE OR REPLACE FUNCTION app.tasks_private_note_secret(p_task_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT h.private_note_secret_id
    FROM (SELECT x.* FROM app.handoffs x WHERE x.task_id = p_task_id AND x.applied_at IS NOT NULL ORDER BY x.created_at DESC, x.id DESC LIMIT 1) h
    JOIN app.tasks t ON t.id = h.task_id AND t.owner_id = h.to_actor_id AND t.state <> 'done'
    JOIN app.actors a ON a.id = h.to_actor_id AND a.kind = 'bot'
   WHERE h.to_actor_id = app.actor()
$$;

-- When a card is done its private notes are no longer needed: delete them (does nothing for a card that is not done).
CREATE FUNCTION app.tasks_drop_private_notes(p_task_id uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.tasks WHERE id = p_task_id AND state = 'done') THEN RETURN 0; END IF;
  DELETE FROM app.secrets WHERE id IN (SELECT private_note_secret_id FROM app.handoffs WHERE task_id = p_task_id AND private_note_secret_id IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- The sweep (system only): notes of done cards, notes older than p_days, and tickets nobody used within an hour.
CREATE FUNCTION app.tasks_sweep_private_notes(p_days integer) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF current_user <> 'manythreads_system' THEN RAISE EXCEPTION 'system only' USING ERRCODE = '42501'; END IF;
  DELETE FROM app.secrets WHERE id IN (
    SELECT h.private_note_secret_id FROM app.handoffs h JOIN app.tasks t ON t.id = h.task_id
     WHERE h.private_note_secret_id IS NOT NULL AND (t.state = 'done' OR h.created_at < now() - make_interval(days => p_days))
    UNION
    SELECT k.secret_id FROM app.handoff_secret_tickets k WHERE k.created_at < now() - interval '1 hour');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_ticket_private_note(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_drop_private_notes(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_sweep_private_notes(integer) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_ticket_private_note(uuid, uuid), app.tasks_sweep_private_notes(integer), app.tasks_drop_private_notes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_ticket_private_note(uuid, uuid), app.tasks_sweep_private_notes(integer) TO manythreads_system;
GRANT EXECUTE ON FUNCTION app.tasks_drop_private_notes(uuid) TO manythreads_app, manythreads_system;
