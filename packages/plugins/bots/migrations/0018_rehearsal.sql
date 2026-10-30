-- bots 0018: rehearsal runs, the data behind the bot page's Test action (PLAN P7-11, SPEC section 9). Forward-only: never edit once applied.
--
-- A rehearsal is one question a team lead or workspace admin asks a bot that already exists, in their own conversation with it. The bot runs for real
-- (its prompt, its knowledge and its read tools), but every write it tries over the platform's tool door is held back and listed instead of done.
-- Three pieces, all here because the bots plugin owns runs:
--
--   * `bot_runs.rehearsal`: the run is a rehearsal. The kernel writes it when the router opens the run and the gateway reads it back from the row on every
--     call, so nothing a caller sends can switch it on or off. Only a conversation run can be one.
--   * `rehearsal_questions`: the question's message. The Test route files it in the same transaction as the message, and the router (which has the message
--     in hand and nothing else to go on) looks the message up here to decide that the run it queues is a rehearsal. Only this one message is a rehearsal:
--     the conversation goes on as an ordinary one if the person keeps typing.
--   * `rehearsal_intercepts`: one line per write the gateway held back: the tool's name and, when the call named one, the path or id it aimed at. Never
--     the text the call would have written.

ALTER TABLE app.bot_runs ADD COLUMN rehearsal boolean NOT NULL DEFAULT false;
ALTER TABLE app.bot_runs ADD CONSTRAINT bot_runs_rehearsal_conversation CHECK (NOT rehearsal OR trigger_type = 'conversation');
CREATE INDEX bot_runs_rehearsal_thread ON app.bot_runs (reply_root_id) WHERE rehearsal;

-- rehearsal_questions (T; asker own) ------------------------------------------------------------------------------------
CREATE TABLE app.rehearsal_questions (
  message_id   uuid PRIMARY KEY REFERENCES app.messages (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  bot_id       uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  asked_by     uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rehearsal_questions_workspace ON app.rehearsal_questions (workspace_id);
CREATE INDEX rehearsal_questions_team ON app.rehearsal_questions (team_id);
CREATE INDEX rehearsal_questions_bot ON app.rehearsal_questions (bot_id, asked_by, created_at DESC);
CREATE INDEX rehearsal_questions_asked_by ON app.rehearsal_questions (asked_by);
COMMENT ON TABLE app.rehearsal_questions IS 'rls: person — P: the questions a team lead or workspace admin asked a bot as a rehearsal; the asker reads and files their own (the message must be theirs and the team one they manage), the router reads all as the system role.';

ALTER TABLE app.rehearsal_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.rehearsal_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY rehearsal_questions_select ON app.rehearsal_questions FOR SELECT USING (
  (SELECT app.is_system())
  OR asked_by = (SELECT app.actor())
);
CREATE POLICY rehearsal_questions_insert ON app.rehearsal_questions FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (
    workspace_id = (SELECT app.workspace_id())
    AND asked_by = (SELECT app.actor())
    AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
    AND EXISTS (SELECT 1 FROM app.bots b WHERE b.id = bot_id AND b.team_id = rehearsal_questions.team_id)
    AND EXISTS (SELECT 1 FROM app.messages m WHERE m.id = message_id AND m.author_id = rehearsal_questions.asked_by)
  )
);
CREATE POLICY rehearsal_questions_system ON app.rehearsal_questions FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT, INSERT ON app.rehearsal_questions TO manythreads_app;

-- rehearsal_intercepts (T) ----------------------------------------------------------------------------------------------
CREATE TABLE app.rehearsal_intercepts (
  run_id     uuid NOT NULL REFERENCES app.bot_runs (id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  capability text NOT NULL CHECK (char_length(capability) BETWEEN 1 AND 100),
  target     text CHECK (target IS NULL OR char_length(target) <= 300),
  would_wait boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq),
  CONSTRAINT rehearsal_intercepts_seq_nonnegative CHECK (seq >= 0)
);
COMMENT ON TABLE app.rehearsal_intercepts IS 'rls: team — T: the writes a rehearsal run tried and the gateway held back (tool name and target, never content); read with the run (a conversation run is its asker''s alone), written only through app.rehearsal_intercept_append by the run itself.';

ALTER TABLE app.rehearsal_intercepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.rehearsal_intercepts FORCE ROW LEVEL SECURITY;
CREATE POLICY rehearsal_intercepts_select ON app.rehearsal_intercepts FOR SELECT USING (
  (SELECT app.is_system())
  OR run_id IN (SELECT r.id FROM app.bot_runs r WHERE r.team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))
);
CREATE POLICY rehearsal_intercepts_system ON app.rehearsal_intercepts FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.rehearsal_intercepts TO manythreads_app;

-- The append door. Like `run_source_log_append` (0004, 0007): the next position is read as the system role, the run is `app.run_id()` (a caller cannot name
-- another), and the lines commit with the call that produced them. It also refuses a run that is not a live rehearsal, so a normal run cannot write a
-- line that says a write was "not done". At most 200 lines a run; past that the call is still held back, the line is just not kept (the page says "and more").
CREATE FUNCTION app.rehearsal_intercept_append(p_capability text, p_target text, p_would_wait boolean) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_run uuid := app.run_id();
  v_seq integer;
BEGIN
  IF v_run IS NULL THEN
    RAISE EXCEPTION 'app.run_id() is not set: an intercepted write belongs to a run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.bot_runs WHERE id = v_run AND rehearsal AND status = 'running') THEN
    RAISE EXCEPTION 'only a live rehearsal run holds writes back';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('rehearsal-intercept:' || v_run::text));
  SELECT coalesce(max(seq), -1) + 1 INTO v_seq FROM app.rehearsal_intercepts WHERE run_id = v_run;
  IF v_seq < 200 THEN
    INSERT INTO app.rehearsal_intercepts (run_id, seq, capability, target, would_wait)
    VALUES (v_run, v_seq, left(p_capability, 100), left(p_target, 300), coalesce(p_would_wait, false));
  END IF;
  RETURN v_seq;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.rehearsal_intercept_append(text, text, boolean) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.rehearsal_intercept_append(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rehearsal_intercept_append(text, text, boolean) TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.rehearsal_intercept_append(text, text, boolean) IS
  'Append one line to the calling live rehearsal run''s list of held-back writes (app.run_id()) and answer its position; refuses any run that is not a rehearsal.';
