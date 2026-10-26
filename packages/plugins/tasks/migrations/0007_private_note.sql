-- tasks plugin 0007: a private note on a handover (live bug: a bot passed test-account passwords in the handoff note, which is also posted
-- as a visible message in the card's thread). Forward-only: never edit once applied.
--
-- A handover may now carry a SECRET note beside the visible one. The text is never stored here: it is sealed in app.secrets (the platform's
-- envelope-encrypted store, which `manythreads_app` cannot SELECT), and the handover row keeps only the secret's id. The id is not the text, so
-- the row stays readable by the team like the rest of the handover; it only tells readers THAT a private note was passed.
--
-- Two narrow SECURITY DEFINER doors, both checking the caller with app.actor() (inside a definer function app.is_system() is always true):
--   * app.tasks_set_private_note(handoff, secret) — only the giver of that handover, once, and only a secret of the card's workspace.
--   * app.tasks_private_note_secret(card)         — the id of the secret, only for the BOT that the card's most recent handover gave the card to,
--                                                  and only while that bot still owns the card; NULL for anyone else, so a person, another bot,
--                                                  or a bot after the card moved on reads nothing. The caller then decrypts it as the system.
ALTER TABLE app.handoffs ADD COLUMN private_note_secret_id uuid REFERENCES app.secrets (id) ON DELETE SET NULL;
CREATE INDEX handoffs_private_note ON app.handoffs (private_note_secret_id) WHERE private_note_secret_id IS NOT NULL;
CREATE INDEX handoffs_task_private ON app.handoffs (task_id) WHERE private_note_secret_id IS NOT NULL;
COMMENT ON COLUMN app.handoffs.private_note_secret_id IS 'The sealed private note of this handover (app.secrets); the text is never in this table, an event or a message.';

CREATE FUNCTION app.tasks_set_private_note(p_handoff_id uuid, p_secret_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE app.handoffs h SET private_note_secret_id = p_secret_id
   WHERE h.id = p_handoff_id AND h.from_actor_id = app.actor() AND h.private_note_secret_id IS NULL
     AND EXISTS (SELECT 1 FROM app.secrets s JOIN app.tasks t ON t.id = h.task_id WHERE s.id = p_secret_id AND s.workspace_id = t.workspace_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$$;

CREATE FUNCTION app.tasks_private_note_secret(p_task_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT h.private_note_secret_id
    FROM app.handoffs h
    JOIN app.tasks t ON t.id = h.task_id AND t.owner_id = h.to_actor_id
    JOIN app.actors a ON a.id = h.to_actor_id AND a.kind = 'bot'
   WHERE h.task_id = p_task_id AND h.to_actor_id = app.actor() AND h.applied_at IS NOT NULL
   ORDER BY h.id DESC
   LIMIT 1
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_set_private_note(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_private_note_secret(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.tasks_set_private_note(uuid, uuid), app.tasks_private_note_secret(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_set_private_note(uuid, uuid), app.tasks_private_note_secret(uuid) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.tasks_set_private_note(uuid, uuid) IS 'Attaches a sealed private note to a handover the caller gave; once.';
COMMENT ON FUNCTION app.tasks_private_note_secret(uuid) IS 'The secret id of the private note of the latest handover that gave the calling bot this card, while it still owns the card; else NULL.';
