-- memory plugin 0002: what retention must not make the feed forget (PLAN P5-14; SPEC §12.1, §15). Forward-only: never edit once applied.
--
--  * The feed's verdict about what a bot WROTE (`app.memory_authored_verdict`) is read from the bot's runs by time window. P5-14's `retention`
--    plugin deletes run logs after 90 days, and a deleted run reads as "the bot wrote this outside a run": a bot message that was withheld (its
--    run read a person source) would be retained the next time its thread is rebuilt (a person replies to it), and a withheld page the next time
--    it is read. So a run that is about to be pruned leaves a MEMO first (`app.memory_memoize_runs`, called by retention in the transaction that
--    deletes the run): its id, its bot, its window and its refusal — never its source lines. `app.memory_authored_verdict` reads the live runs
--    and the memos as one set, with the same window rules, so a verdict does not change when the run it was made from is pruned.
--  * A memo is written only for a run whose verdict can change something: a REFUSING run that left a footprint — something the bot authored in
--    its window (a message in a public channel, a commit), or any line of the feed's own about the run (its summary was withheld, a message of
--    its was withheld: a commit of the bot may be in git and not in `repo_commits` yet, the reindex heals lazily, and after it the page's time
--    falls inside the pruned run's window) — or a run an approval was filed from (`approvals.run_id` is SET NULL when the run goes; the memo keeps
--    `approval_ids` so the approval's verdict survives too, clean or not). A run that read only team-visible sources, or left no footprint and has
--    no approval, leaves nothing: the verdict "no refusal" is what an absent run answers anyway. (A run summary the bank holds is not a reason:
--    a run that is gone, for any reason, keeps its summary in the bank — `resolveRun` answers `skip`, never `forget`.) So the table holds one row
--    per refusing run with a footprint, plus one per run that has an approval.
--  * `source_kind` gains `concept`: a file of the team's OKF bundle (`memory/`), mirrored into the bank by `memory-git-mirror` (P5-14).
--  * `app.memory_retain_log_prune`: the one door through which log lines are ever removed, for retention. The log is append-only for the system
--    role (0001 revokes DELETE); the door is owned by the table's owner and has two policies of its own, so nothing else gains a privilege. It
--    removes only attempt notes (`not_configured`, `failed`) and lines a newer retained/forgotten line of the same source has superseded: never
--    the newest state of a source (it says what the bank holds, so a later forget finds the document), and never a `withheld` line (SPEC §15's
--    "what was withheld" record).

-- concept as a source kind -----------------------------------------------------------------------------------------------
ALTER TABLE app.memory_retain_log DROP CONSTRAINT memory_retain_log_source_kind_check;
ALTER TABLE app.memory_retain_log ADD CONSTRAINT memory_retain_log_source_kind_check
  CHECK (source_kind IN ('message', 'thread', 'run', 'approval', 'page', 'run_tool', 'concept'));

-- the memo of a pruned run ----------------------------------------------------------------------------------------------
CREATE TABLE app.memory_run_memo (
  run_id         uuid PRIMARY KEY,   -- no foreign key: the run is gone
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  bot_id         uuid NOT NULL,      -- no foreign key: the bot may be removed (then every verdict is `bot_removed` and the memo is swept)
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz NOT NULL,
  -- `app.run_retain_verdict` at the moment the run was pruned (null: the run read nothing narrower than the team)
  retain_refusal text CHECK (retain_refusal IS NULL OR char_length(retain_refusal) BETWEEN 1 AND 40),
  approval_ids   uuid[] NOT NULL DEFAULT '{}',
  memoized_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_run_memo_window CHECK (ended_at >= started_at)
);
CREATE INDEX memory_run_memo_bot ON app.memory_run_memo (bot_id, started_at);
CREATE INDEX memory_run_memo_workspace ON app.memory_run_memo (workspace_id);
CREATE INDEX memory_run_memo_team ON app.memory_run_memo (team_id);
CREATE INDEX memory_run_memo_approvals ON app.memory_run_memo USING gin (approval_ids);
COMMENT ON TABLE app.memory_run_memo IS 'rls: system — S: what a pruned run still says (its window, its bot and its refusal, never its source lines), so the feed''s verdict about what a bot wrote does not change when retention deletes the run; no privilege for manythreads_app.';

ALTER TABLE app.memory_run_memo ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_run_memo FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_run_memo_system ON app.memory_run_memo FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- Called by retention with the ids of runs it is about to delete, in the same transaction. Returns how many memos it wrote. Idempotent.
CREATE FUNCTION app.memory_memoize_runs(p_run_ids uuid[])
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_written integer;
BEGIN
  WITH cand AS (
    SELECT r.id, r.workspace_id, r.team_id, r.bot_id, r.started_at, r.ended_at,
           (SELECT a.id FROM app.actors a WHERE a.kind = 'bot' AND a.ref_id = r.bot_id AND a.workspace_id = r.workspace_id) AS bot_actor
      FROM app.bot_runs r
     WHERE r.id = ANY (p_run_ids) AND r.ended_at IS NOT NULL
  ), judged AS (
    SELECT c.*, v.retain_refusal,
           ARRAY(SELECT ap.id FROM app.approvals ap WHERE ap.run_id = c.id) AS approvals,
           (c.bot_actor IS NOT NULL AND (
              EXISTS (
                SELECT 1 FROM app.messages m JOIN app.channels ch ON ch.id = m.channel_id
                 WHERE m.author_id = c.bot_actor AND m.deleted_at IS NULL
                   AND ch.kind = 'channel' AND NOT ch.private AND ch.team_id IS NOT NULL
                   AND m.created_at BETWEEN c.started_at - interval '2 seconds' AND c.ended_at + interval '2 seconds')
              OR EXISTS (
                SELECT 1 FROM app.repo_commits rc
                 WHERE rc.team_id = c.team_id AND rc.author_id = c.bot_actor
                   AND (rc.committed_at BETWEEN c.started_at - interval '2 seconds' AND c.ended_at + interval '2 seconds'
                        OR rc.indexed_at BETWEEN c.started_at - interval '2 seconds' AND c.ended_at + interval '2 seconds'))
           )) AS authored,
           -- any line of the feed's about the run: the withheld summary of a refusing run, a withheld message or page that names it
           EXISTS (SELECT 1 FROM app.memory_retain_log l WHERE l.run_id = c.id OR (l.source_kind = 'run' AND l.source_id = c.id::text)) AS footprint
      FROM cand c
      CROSS JOIN LATERAL app.run_retain_verdict(c.id) v
  ), ins AS (
    INSERT INTO app.memory_run_memo (run_id, workspace_id, team_id, bot_id, started_at, ended_at, retain_refusal, approval_ids)
    SELECT j.id, j.workspace_id, j.team_id, j.bot_id, j.started_at, j.ended_at, j.retain_refusal, j.approvals
      FROM judged j
     WHERE (j.retain_refusal IS NOT NULL AND (j.authored OR j.footprint)) OR cardinality(j.approvals) > 0
    ON CONFLICT (run_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_written FROM ins;
  RETURN v_written;
END
$$;

ALTER FUNCTION app.memory_memoize_runs(uuid[]) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.memory_memoize_runs(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_memoize_runs(uuid[]) TO manythreads_system;
COMMENT ON FUNCTION app.memory_memoize_runs(uuid[]) IS
  'Leaves a memo (window, bot, refusal, approvals) for each of these ended runs that still matters to the feed, before retention deletes them. System role only.';

-- the authored verdict, now over live runs AND memos ------------------------------------------------------------------------
-- Same signature, same window rules as 0001 (a run covers [started - 2 s, ended + 2 s]; none that started more than a day before the instant is
-- looked for; an open run defers). The memo half has no open runs: a memo is only made for a run that ended.
CREATE OR REPLACE FUNCTION app.memory_authored_verdict(p_bot_actor uuid, p_at timestamptz)
  RETURNS TABLE (run_open boolean, retain_refusal text, runs integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
  WITH bot AS (
    SELECT a.id, a.ref_id, a.workspace_id, EXISTS (SELECT 1 FROM app.bots b WHERE b.id = a.ref_id) AS present
      FROM app.actors a
     WHERE a.id = p_bot_actor AND a.kind = 'bot'
  ), judged AS (
    SELECT r.id, (r.ended_at IS NULL AND r.status = 'running') AS is_open, v.retain_refusal
      FROM bot
      JOIN app.bot_runs r ON r.bot_id = bot.ref_id AND r.workspace_id = bot.workspace_id
      CROSS JOIN LATERAL app.run_retain_verdict(r.id) v
     WHERE r.started_at <= p_at + interval '2 seconds'
       AND r.started_at > p_at - interval '24 hours'
       AND (CASE WHEN r.ended_at IS NOT NULL THEN p_at - interval '2 seconds' <= r.ended_at ELSE r.status = 'running' END)
    UNION ALL
    SELECT m.run_id, false, m.retain_refusal
      FROM bot
      JOIN app.memory_run_memo m ON m.bot_id = bot.ref_id AND m.workspace_id = bot.workspace_id
     WHERE m.started_at <= p_at + interval '2 seconds'
       AND m.started_at > p_at - interval '24 hours'
       AND p_at - interval '2 seconds' <= m.ended_at
  )
  SELECT coalesce(bool_or(j.is_open), false),
         coalesce(
           (array_agg(j.retain_refusal ORDER BY j.id) FILTER (WHERE j.retain_refusal IS NOT NULL))[1],
           CASE WHEN EXISTS (SELECT 1 FROM bot WHERE NOT bot.present) THEN 'bot_removed' END),
         count(j.id)::integer
    FROM judged j
$$;

-- the door that removes log lines -------------------------------------------------------------------------------------------
-- Owned by the migrating role (the table's owner): the system role holds no DELETE on the log (0001) and gains none. The owner is subject to the
-- table's row level security (FORCE), so it gets one SELECT and one DELETE policy of its own, `TO manythreads_owner`: the role is only ever in
-- effect inside this function (no request path logs in as it), and `manythreads_system` may execute the function and nothing more.
CREATE POLICY memory_retain_log_owner_select ON app.memory_retain_log FOR SELECT TO manythreads_owner USING (true);
CREATE POLICY memory_retain_log_owner_delete ON app.memory_retain_log FOR DELETE TO manythreads_owner USING (true);

-- One page: the next `p_limit` lines of the workspace after `p_after` (in id order, older than `p_before`), of which the doomed are deleted
-- (or only counted, `p_dry_run`). `last_id` is where the next page starts; `exhausted` says there is none. Never `withheld`, never the newest
-- retained/forgotten line of a source.
CREATE FUNCTION app.memory_retain_log_prune(p_workspace uuid, p_before timestamptz, p_after uuid, p_limit integer, p_dry_run boolean)
  RETURNS TABLE (pruned integer, last_id uuid, exhausted boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ids   uuid[];
  v_last  uuid;
  v_seen  integer;
  v_gone  integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'memory_retain_log_prune: limit must be between 1 and 10000' USING ERRCODE = '22023';
  END IF;
  WITH page AS (
    SELECT l.id, l.outcome, l.source_kind, l.source_id
      FROM app.memory_retain_log l
     WHERE l.workspace_id = p_workspace
       AND l.id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
       AND l.created_at < p_before
     ORDER BY l.id
     LIMIT p_limit
  )
  SELECT coalesce(array_agg(p.id) FILTER (WHERE
           p.outcome IN ('not_configured', 'failed')
           OR (p.outcome IN ('retained', 'forgotten')
               AND p.id <> (SELECT s.id FROM app.memory_retain_log s
                             WHERE s.source_kind = p.source_kind AND s.source_id = p.source_id AND s.outcome IN ('retained', 'forgotten')
                             ORDER BY s.id DESC LIMIT 1))), '{}'::uuid[]),
         (array_agg(p.id ORDER BY p.id DESC))[1], count(*)::integer
    INTO v_ids, v_last, v_seen
    FROM page p;
  IF cardinality(v_ids) > 0 THEN
    IF p_dry_run THEN
      v_gone := cardinality(v_ids);
    ELSE
      DELETE FROM app.memory_retain_log WHERE id = ANY (v_ids);
      GET DIAGNOSTICS v_gone = ROW_COUNT;
    END IF;
  END IF;
  RETURN QUERY SELECT v_gone, v_last, v_seen < p_limit;
END
$$;

REVOKE ALL ON FUNCTION app.memory_retain_log_prune(uuid, timestamptz, uuid, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_retain_log_prune(uuid, timestamptz, uuid, integer, boolean) TO manythreads_system;
COMMENT ON FUNCTION app.memory_retain_log_prune(uuid, timestamptz, uuid, integer, boolean) IS
  'Retention''s door to the append-only retain log: removes attempt notes and superseded retained/forgotten lines older than p_before, a page at a time. Never a withheld line, never the newest state of a source. System role only.';
