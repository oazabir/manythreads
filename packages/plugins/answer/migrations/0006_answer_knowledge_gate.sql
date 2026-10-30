-- answer 0006: a bot that answers only from its knowledge bases (BOT.md `knowledge: [{ base, answer_only_from: true }]`, PLAN P8-08) may post an Answer
-- only after it searched them. Forward-only: never edit once applied.
--
-- app.answer_knowledge_gate()   SECURITY DEFINER, system-owned: for the calling run only (`app.run_id()`, while it is live), whether its bot lists a
--                               base it answers only from (`strict`) and whether the run's source log holds a passage read from a knowledge base
--                               (`used`). The bot's row and the run's log are not readable by the bot itself.
CREATE FUNCTION app.answer_knowledge_gate() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_strict boolean;
  v_used boolean;
BEGIN
  SELECT EXISTS (
           SELECT 1
             FROM app.bot_runs r
             JOIN app.bots b ON b.id = r.bot_id
            CROSS JOIN LATERAL jsonb_array_elements(coalesce(b.knowledge, '[]'::jsonb)) k
            WHERE r.id = app.run_id() AND r.status = 'running' AND r.ended_at IS NULL AND k ->> 'answer_only_from' = 'true')
    INTO v_strict;
  SELECT EXISTS (SELECT 1 FROM app.answer_run_sources() l WHERE l.source_type = 'knowledge') INTO v_used;
  RETURN jsonb_build_object('strict', v_strict, 'used', v_used);
END
$$;
REVOKE ALL ON FUNCTION app.answer_knowledge_gate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.answer_knowledge_gate() TO manythreads_app, manythreads_system;

-- Owned by the system role like every other definer function (a login that can set up the schema would otherwise be the one whose rights these run with).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.answer_knowledge_gate() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
