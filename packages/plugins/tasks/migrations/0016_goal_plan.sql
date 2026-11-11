-- tasks plugin 0016: a goal gets a short number, a budget, a place (channel and thread) and a plan. Forward-only: never edit once applied.
--
-- A goal is the line of work several cards point at. The plan card (Phase 22) shows one goal in its channel: `G-27 · name`, the steps, what it cost.
--  * `number` is the short name inside a team (`G-27`). The database gives it, never the caller: a BEFORE INSERT trigger takes the next value of the
--    team's counter row (app.goal_counters) and overwrites whatever the insert named. The counter row is locked until the end of the transaction by
--    the upsert that takes the value, so two goals made at once in one team get two numbers. A number is never reused; a goal insert that loses a race
--    for the thread (see the unique index below) may leave a gap. Existing goals are numbered by creation time.
--  * `budget_usd` is shown beside the spend; nothing stops a run at the budget.
--  * `channel_id` and `thread_root_id` are the team channel and the thread (its first message) the goal was given in, set by the `goals.ensure` tool
--    from the bot's run. One goal per thread of a team: a partial unique index, so a restarted run finds the goal it made.
--  * `steps` is the plan: up to 12 entries `{title, bots:[slug], cardRef?, done}`. Whether a step is done is never stored; it is worked out from the cards.
--
-- app.tasks_run_thread(): the team channel and the thread the caller's live bot run answers in (same conditions as app.tasks_link_run_thread).
-- app.tasks_goal_spend(goal): what the goal's runs cost, in dollars. It reads app.llm_spend, which only workspace admins may read, so it is a narrow
--   definer door: it answers only to a caller that reads the goal's team, takes nothing but the goal id, and sums only the runs of that goal (runs woken
--   by a card of the goal, and runs answering in the goal's thread). It answers NULL when the model gateway's ledger is not installed.

CREATE TABLE app.goal_counters (
  team_id     uuid PRIMARY KEY REFERENCES app.teams (id) ON DELETE CASCADE,
  last_number integer NOT NULL CHECK (last_number >= 0)
);
COMMENT ON TABLE app.goal_counters IS 'rls: system — S: the last goal number given in each team; only the numbering trigger of app.goals writes it.';

ALTER TABLE app.goals
  ADD COLUMN number         integer,
  ADD COLUMN budget_usd     numeric(12, 2) CHECK (budget_usd IS NULL OR budget_usd >= 0),
  ADD COLUMN channel_id     uuid REFERENCES app.channels (id) ON DELETE SET NULL,
  ADD COLUMN thread_root_id uuid REFERENCES app.messages (id) ON DELETE SET NULL,
  ADD COLUMN steps          jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) <= 12);

-- Number the goals that exist, oldest first per team, and start each team's counter at its highest number. The migration runs as the table owner, to
-- whom FORCE ROW LEVEL SECURITY applies and no policy gives a row, so the force is lifted for this one statement group and put back.
ALTER TABLE app.goals NO FORCE ROW LEVEL SECURITY;
UPDATE app.goals g SET number = n.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY team_id ORDER BY created_at, id)::integer AS rn FROM app.goals) n
 WHERE g.id = n.id;
ALTER TABLE app.goals FORCE ROW LEVEL SECURITY;
INSERT INTO app.goal_counters (team_id, last_number) SELECT team_id, max(number) FROM app.goals GROUP BY team_id;

ALTER TABLE app.goal_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.goal_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY goal_counters_system ON app.goal_counters FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
REVOKE ALL ON app.goal_counters FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.goal_counters TO manythreads_system;

ALTER TABLE app.goals ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX goals_team_number ON app.goals (team_id, number);
CREATE UNIQUE INDEX goals_team_thread ON app.goals (team_id, thread_root_id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX goals_thread_root ON app.goals (thread_root_id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX goals_channel ON app.goals (channel_id) WHERE channel_id IS NOT NULL;
COMMENT ON TABLE app.goals IS 'rls: team — T: goals of the teams the caller can read; written by team writers. `number` is given by the numbering trigger.';

-- The numbering trigger (definer, owned by the system role: the counter table has no grant for the app role).
CREATE FUNCTION app.goals_assign_number() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.number IS DISTINCT FROM OLD.number OR NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RAISE EXCEPTION 'the number and the team of a goal do not change' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- one statement takes the next value and holds the counter row's lock to the end of the transaction
  INSERT INTO app.goal_counters (team_id, last_number) VALUES (NEW.team_id, 1)
  ON CONFLICT (team_id) DO UPDATE SET last_number = app.goal_counters.last_number + 1
  RETURNING last_number INTO NEW.number;
  RETURN NEW;
END
$$;
CREATE TRIGGER goals_assign_number BEFORE INSERT ON app.goals FOR EACH ROW EXECUTE FUNCTION app.goals_assign_number();
CREATE TRIGGER goals_keep_number BEFORE UPDATE OF number, team_id ON app.goals FOR EACH ROW EXECUTE FUNCTION app.goals_assign_number();

-- The team channel and the thread root of the caller's live bot run. Answers no row for a person, a run that ended, a run that answers in no thread, a
-- deleted message, a direct message or bot conversation, an archived channel. Never raises.
CREATE FUNCTION app.tasks_run_thread() RETURNS TABLE (o_team_id uuid, o_channel_id uuid, o_thread_root_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT c.team_id, c.id, coalesce(m.thread_root_id, m.id)
    FROM app.bot_runs r
    JOIN app.actors bot ON bot.kind = 'bot' AND bot.ref_id = r.bot_id AND bot.workspace_id = r.workspace_id
    JOIN app.messages m ON m.id = r.reply_root_id AND m.workspace_id = r.workspace_id AND m.deleted_at IS NULL
    JOIN app.channels c ON c.id = m.channel_id AND c.kind = 'channel' AND c.archived_at IS NULL AND c.team_id IS NOT NULL
   WHERE r.id = app.run_id() AND r.status = 'running' AND r.ended_at IS NULL AND bot.id = app.actor()
$$;

-- What a goal's runs cost, in dollars (numeric, two decimals); NULL for a caller who cannot read the goal's team, a goal that does not exist, or a
-- deployment without the model gateway's ledger. Inside a definer function app.is_system() is true, so the caller is checked with
-- app.readable_team_ids('read') (itself a definer that reads the caller's own actor and workspace, and answers nothing for the system actor).
CREATE FUNCTION app.tasks_goal_spend(p_goal uuid) RETURNS numeric
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  g app.goals;
  v numeric;
BEGIN
  SELECT * INTO g FROM app.goals WHERE id = p_goal;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF g.workspace_id IS DISTINCT FROM app.workspace_id() OR NOT (g.team_id = ANY (app.readable_team_ids('read'))) THEN RETURN NULL; END IF;
  IF to_regclass('app.llm_spend') IS NULL OR to_regclass('app.bot_runs') IS NULL THEN RETURN NULL; END IF;
  SELECT round(coalesce(sum(s.cost_usd), 0), 2) INTO v
    FROM app.llm_spend s
   WHERE s.workspace_id = g.workspace_id
     AND s.run_id IN (
       SELECT r.id FROM app.bot_runs r
        WHERE r.team_id = g.team_id AND r.workspace_id = g.workspace_id
          AND r.task_id IN (SELECT t.id FROM app.tasks t WHERE t.goal_id = g.id)
       UNION
       SELECT r.id FROM app.bot_runs r JOIN app.messages m ON m.id = r.reply_root_id
        WHERE g.thread_root_id IS NOT NULL AND r.team_id = g.team_id AND r.workspace_id = g.workspace_id
          AND (m.id = g.thread_root_id OR m.thread_root_id = g.thread_root_id)
     );
  RETURN v;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.goals_assign_number() OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_run_thread() OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_goal_spend(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.goals_assign_number(), app.tasks_run_thread(), app.tasks_goal_spend(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_run_thread(), app.tasks_goal_spend(uuid) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.goals_assign_number() TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.tasks_goal_spend(uuid) IS 'What the runs of a goal cost in dollars; answers only to a caller who reads the goal''s team, and NULL when the model ledger is absent.';
