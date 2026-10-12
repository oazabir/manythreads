-- memory-hindsight 0002: the narrowest-source rule and the retain log (PLAN P5-13). Forward-only: never edit once applied.
--
--  * `app.memory_run_scope()` (0001) decided "may this run add to its team's bank" with its own conservative check. The decision itself moved to
--    `app.run_retain_verdict(run)` of the `memory` plugin (0001 there), which the feed's run summaries use too, so there is one rule and one
--    place to read it. The refusals and their order are the ones 0001 had (person_source, private_source, conversation, private_channel,
--    private_thread); the rule is one step stricter: a `message` line is resolved to its channel whatever scope label it carries (0001 only looked
--    at lines labelled `channel`, so a private message logged as `team` passed). Same columns, same grants, same trust base as 0001.
--  * `app.memory_retain_log_run(outcome, bank, document_ids)`: the one door through which a run's own `memory.retain` writes `memory_retain_log`
--    (`retained` per document, or `withheld` with the refusal as the reason). It finds the run, team and source scopes itself through
--    `app.memory_run_scope()` — so it writes for the caller's own live run and for nothing else — and returns how many lines it wrote.

CREATE OR REPLACE FUNCTION app.memory_run_scope()
  RETURNS TABLE (run_id uuid, team_id uuid, team_slug text, workspace_slug text, workspace_id uuid, bot_id uuid, retain_refusal text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT r.id, r.team_id, t.slug, w.slug, r.workspace_id, r.bot_id,
         (SELECT v.retain_refusal FROM app.run_retain_verdict(r.id) v)
    FROM app.bot_runs r
    JOIN app.teams t ON t.id = r.team_id
    JOIN app.workspaces w ON w.id = r.workspace_id
    JOIN app.actors bot_actor ON bot_actor.kind = 'bot' AND bot_actor.ref_id = r.bot_id AND bot_actor.workspace_id = r.workspace_id
   WHERE r.id = app.run_id()
     AND r.status = 'running'
     AND r.ended_at IS NULL
     AND (app.actor() = bot_actor.id OR (r.asker_id IS NOT NULL AND app.actor() = r.asker_id));
END
$$;

ALTER FUNCTION app.memory_run_scope() OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.memory_run_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_run_scope() TO manythreads_app, manythreads_system;

CREATE FUNCTION app.memory_retain_log_run(p_outcome text, p_bank text, p_document_ids text[]) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  s record;
  v record;
  d text;
  n integer := 0;
BEGIN
  IF p_outcome NOT IN ('retained', 'withheld') THEN
    RAISE EXCEPTION 'a run logs retained or withheld, not %', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- the caller's own live run, or nothing: the same check that gives a run its bank
  SELECT * INTO s FROM app.memory_run_scope();
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  SELECT * INTO v FROM app.run_retain_verdict(s.run_id);

  IF p_outcome = 'withheld' THEN
    INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, reason, run_id, source_scopes, actor_id)
    VALUES (s.workspace_id, s.team_id, left(p_bank, 200), 'run_tool', 'refused:' || s.run_id::text, 'withheld',
            coalesce(s.retain_refusal, v.retain_refusal, 'refused'), s.run_id, coalesce(v.source_scopes, '{}'), app.actor());
    RETURN 1;
  END IF;

  FOREACH d IN ARRAY coalesce(p_document_ids, '{}'::text[]) LOOP
    INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, document_id, outcome, run_id, source_scopes, actor_id)
    VALUES (s.workspace_id, s.team_id, left(p_bank, 200), 'run_tool', left(d, 1100), left(d, 200), 'retained', s.run_id,
            coalesce(v.source_scopes, '{}'), app.actor());
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;

ALTER FUNCTION app.memory_retain_log_run(text, text, text[]) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.memory_retain_log_run(text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_retain_log_run(text, text, text[]) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.memory_retain_log_run(text, text, text[]) IS
  'Log the calling run''s own memory.retain (retained per document, or withheld with the refusal): the run, team and scopes come from app.memory_run_scope(); no line for anyone who is not a live run''s bot or asker.';
