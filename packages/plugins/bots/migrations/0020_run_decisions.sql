-- bots 0020: what a run's guards and gates decided, kept so it can be checked again later (PLAN P7-07). Forward-only: never edit once applied.
--
-- A run passes three kinds of check before it does anything: the bot's gate (a list of topics that go to a person first), the guard (the workspace's data-loss
-- and where-may-it-go rules, run before every model call) and the tool door (is this call granted, does it wait for a person). Their outcomes were only ever
-- logged for the cases that stopped something (events), and never what the check had looked at. This table keeps one short line per decision, content-blind:
-- the kind, what it was about (a tool name, a model alias, the gate), the outcome, the place a call aimed at, the message the gate read (an id, never its text;
-- it is read again through the person's own access) and a few fixed facts (the guard preset then, the names of the detectors that fired). The Workshop's replay
-- (docs/plugins/workshop.md) reads these lines and asks the CURRENT rules the same question, without calling a model and without writing anything.
--
-- Written only through app.run_decision_append by the run itself (app.run_id()), so a caller cannot name another run; read with the run (the same rule as the
-- run's source log: it follows the run's own row policy, so a conversation run is its asker's alone and every other run is the team's readers).
CREATE TABLE app.run_decisions (
  run_id     uuid NOT NULL REFERENCES app.bot_runs (id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('gate', 'guard', 'tool')),
  subject    text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 100),
  outcome    text NOT NULL CHECK (outcome IN ('passed', 'held', 'refused', 'allow', 'redact', 'require_approval', 'block', 'allowed', 'needs_approval', 'denied')),
  target     text CHECK (target IS NULL OR char_length(target) <= 300),
  message_id uuid,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq),
  CONSTRAINT run_decisions_seq_nonnegative CHECK (seq >= 0)
);
CREATE INDEX run_decisions_created ON app.run_decisions USING brin (created_at);
COMMENT ON TABLE app.run_decisions IS 'rls: team — T: what a run''s gate, guard and tool door decided (kinds, outcomes, a target, a message id, fixed facts; never message text), read with the run; written only through app.run_decision_append by the run itself.';

ALTER TABLE app.run_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY run_decisions_select ON app.run_decisions FOR SELECT USING (
  (SELECT app.is_system())
  OR run_id IN (SELECT r.id FROM app.bot_runs r WHERE r.team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))
);
CREATE POLICY run_decisions_system ON app.run_decisions FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.run_decisions TO manythreads_app;

-- The append door. Like `rehearsal_intercept_append` (0018): the run is `app.run_id()`, the next position is read as the system role, the line commits with the
-- call that produced it. At most 300 lines a run; past that the decision is still made, the line is just not kept (the replay says "and more").
CREATE FUNCTION app.run_decision_append(p_kind text, p_subject text, p_outcome text, p_target text, p_message_id uuid, p_detail jsonb) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_run uuid := app.run_id();
  v_seq integer;
BEGIN
  IF v_run IS NULL THEN
    RAISE EXCEPTION 'app.run_id() is not set: a decision belongs to a run';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('run-decision:' || v_run::text));
  SELECT coalesce(max(seq), -1) + 1 INTO v_seq FROM app.run_decisions WHERE run_id = v_run;
  IF v_seq < 300 THEN
    INSERT INTO app.run_decisions (run_id, seq, kind, subject, outcome, target, message_id, detail)
    VALUES (v_run, v_seq, p_kind, left(p_subject, 100), p_outcome, left(p_target, 300), p_message_id, coalesce(p_detail, '{}'::jsonb));
  END IF;
  RETURN v_seq;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.run_decision_append(text, text, text, text, uuid, jsonb) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.run_decision_append(text, text, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.run_decision_append(text, text, text, text, uuid, jsonb) TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.run_decision_append(text, text, text, text, uuid, jsonb) IS
  'Append one line to the calling run''s list of guard, gate and tool decisions (app.run_id()) and answer its position.';
