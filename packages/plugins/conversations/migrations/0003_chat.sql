-- conversations 0003: the Chat screen's fields (PLAN P20-16). Forward-only: never edit once applied.
--
-- A conversation gains what the history rail needs: a title (made by the `fast` model from the first exchange, or typed by the person), a pin, a soft delete
-- with 30 seconds to undo, and the model alias the person last chose. The person writes exactly these five columns of their own row; everything else of the
-- index stays the system's (the indexing subscriber, the sharing door). Two tables hold what one turn of a conversation carries:
--
--   * conversation_variants: every answer a bot gave to one message of the person (Regenerate and Edit-then-resend add one each). One row per answer; `chosen`
--     marks the one the screen shows and later turns continue from. The subscriber below writes them as the system; the person switches the chosen one through
--     the definer function (a unique partial index would trip mid-statement, so the function flips all rows of the turn in one statement).
--   * conversation_feedback: a thumb on an answer with a one-line reason. Person-only, in both directions: nobody else reads it, an admin included. The
--     `conversations.feedback.given` event carries ids and the vote, never the reason.
--
-- Inside a SECURITY DEFINER function owned by manythreads_system, app.is_system() is always true (MISTAKES P2 review): the caller is checked with
-- app.person_id() and the rows, never the is_* helpers.

ALTER TABLE app.conversations
  ADD COLUMN title        text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 80),
  ADD COLUMN title_source text CHECK (title_source IS NULL OR title_source IN ('auto', 'manual')),
  ADD COLUMN pinned_at    timestamptz,
  ADD COLUMN deleted_at   timestamptz,
  ADD COLUMN model_alias  text CHECK (model_alias IS NULL OR char_length(model_alias) BETWEEN 1 AND 40),
  ADD CONSTRAINT conversations_title_pair CHECK ((title IS NULL) = (title_source IS NULL));
-- the live lists: a person's own, newest thread first, without the deleted ones; the pinned ones first
CREATE INDEX conversations_person_live ON app.conversations (bot_id, person_id, thread_root_id DESC) WHERE deleted_at IS NULL;
CREATE INDEX conversations_person_pinned ON app.conversations (person_id, pinned_at) WHERE pinned_at IS NOT NULL;

-- The person edits the five columns of their own row and nothing else (a column grant, not a policy, draws that line).
CREATE POLICY conversations_own_update ON app.conversations FOR UPDATE
  USING (person_id = (SELECT app.person_id()))
  WITH CHECK (person_id = (SELECT app.person_id()));
GRANT UPDATE (title, title_source, pinned_at, deleted_at, model_alias) ON app.conversations TO manythreads_app;

-- A deleted conversation can be brought back for 30 seconds; after that only the system role (retention) touches it.
CREATE FUNCTION app.conversations_restore_window() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND OLD.deleted_at < now() - interval '30 seconds' AND NOT app.is_system() THEN
    RAISE EXCEPTION 'a deleted conversation can only be restored in the first 30 seconds' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NOT app.is_system() THEN
    NEW.deleted_at := OLD.deleted_at;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_restore_window BEFORE UPDATE OF deleted_at ON app.conversations
  FOR EACH ROW EXECUTE FUNCTION app.conversations_restore_window();

-- conversation_variants (P; person own) -------------------------------------------------------------------------------------
CREATE TABLE app.conversation_variants (
  reply_message_id uuid PRIMARY KEY REFERENCES app.messages (id) ON DELETE CASCADE,
  turn_message_id  uuid NOT NULL REFERENCES app.messages (id) ON DELETE CASCADE,
  thread_root_id   uuid NOT NULL REFERENCES app.conversations (thread_root_id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  person_id        uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  variant_no       integer NOT NULL CHECK (variant_no >= 1),
  chosen           boolean NOT NULL DEFAULT true,
  model_alias      text CHECK (model_alias IS NULL OR char_length(model_alias) BETWEEN 1 AND 40),
  stopped          boolean NOT NULL DEFAULT false,
  run_id           uuid REFERENCES app.bot_runs (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (turn_message_id, variant_no)
);
CREATE INDEX conversation_variants_thread ON app.conversation_variants (thread_root_id);
CREATE INDEX conversation_variants_workspace ON app.conversation_variants (workspace_id);
CREATE INDEX conversation_variants_person ON app.conversation_variants (person_id);
CREATE INDEX conversation_variants_run ON app.conversation_variants (run_id) WHERE run_id IS NOT NULL;
COMMENT ON TABLE app.conversation_variants IS 'rls: person — P: the answers a bot gave to one message of a conversation (Regenerate keeps the earlier ones); the asker reads their own, the system role writes them, and the asker switches the chosen one through app.conversations_choose_variant.';
ALTER TABLE app.conversation_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.conversation_variants FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_variants_select ON app.conversation_variants FOR SELECT USING (
  (SELECT app.is_system()) OR person_id = (SELECT app.person_id())
);
CREATE POLICY conversation_variants_system ON app.conversation_variants FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.conversation_variants TO manythreads_app;

CREATE FUNCTION app.conversations_choose_variant(p_turn uuid, p_reply uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_me uuid := app.person_id();
  n    integer;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'only a person can choose an answer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.conversation_variants v WHERE v.turn_message_id = p_turn AND v.reply_message_id = p_reply AND v.person_id = v_me) THEN
    RETURN false;
  END IF;
  UPDATE app.conversation_variants v SET chosen = (v.reply_message_id = p_reply) WHERE v.turn_message_id = p_turn AND v.person_id = v_me;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;
REVOKE ALL ON FUNCTION app.conversations_choose_variant(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.conversations_choose_variant(uuid, uuid) TO manythreads_app, manythreads_system;

-- conversation_feedback (P; person only) ------------------------------------------------------------------------------------
CREATE TABLE app.conversation_feedback (
  message_id   uuid NOT NULL REFERENCES app.messages (id) ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  vote         text NOT NULL CHECK (vote IN ('up', 'down')),
  reason       text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 140),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, person_id)
);
CREATE INDEX conversation_feedback_person ON app.conversation_feedback (person_id);
CREATE INDEX conversation_feedback_workspace ON app.conversation_feedback (workspace_id);
COMMENT ON TABLE app.conversation_feedback IS 'rls: person — P: a thumb up or down, with a one-line reason, on one answer of the person''s own conversation; only that person reads or writes it (the system role reads it for the eval harness).';
ALTER TABLE app.conversation_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.conversation_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_feedback_select ON app.conversation_feedback FOR SELECT USING (
  (SELECT app.is_system()) OR person_id = (SELECT app.person_id())
);
CREATE POLICY conversation_feedback_insert ON app.conversation_feedback FOR INSERT WITH CHECK (
  person_id = (SELECT app.person_id())
  AND workspace_id = (SELECT app.workspace_id())
  AND EXISTS (
    SELECT 1 FROM app.messages m JOIN app.conversations c ON c.thread_root_id = m.thread_root_id
     WHERE m.id = message_id AND c.person_id = (SELECT app.person_id()))
);
CREATE POLICY conversation_feedback_update ON app.conversation_feedback FOR UPDATE
  USING (person_id = (SELECT app.person_id())) WITH CHECK (person_id = (SELECT app.person_id()));
CREATE POLICY conversation_feedback_delete ON app.conversation_feedback FOR DELETE USING (person_id = (SELECT app.person_id()));
CREATE POLICY conversation_feedback_system ON app.conversation_feedback FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.conversation_feedback TO manythreads_app;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.conversations_choose_variant(uuid, uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
