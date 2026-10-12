-- memory plugin 0001: what the platform retains into a team's memory bank, and why (PLAN A.5, P5-13; SPEC §12.1, §15). Forward-only: never edit
-- once applied.
--
--  * memory_retain_log: an append-only record of every decision about putting something into a team's bank: retained, forgotten (replaced by an
--    edit, deleted, no longer team-visible), withheld (a run read something narrower than the team), not_configured (no engine), failed.
--    It holds ids, a content hash, a reason in words and the scopes of the run's source log — never the retained text. The newest line of a
--    source says what is in the bank for it, which is how an unchanged re-delivery is recognised and how an edit finds the document to replace.
--    Readable by the team's leads and by workspace admins (`manage` on the team); written by the system role and by the run's own
--    `memory.retain` door (memory-hindsight 0002), nobody else.
--  * memory_feed_pending: the feed's work list. An event only marks "this source changed"; the drain job reads the source as it is NOW, decides,
--    and talks to the engine — so a burst of edits is one retain, an out-of-order delivery cannot bring back a deleted message, and the engine
--    being down never blocks the outbox. System only.
--  * app.run_retain_verdict(run): the narrowest-source rule (SPEC §12.1/§15: a run keeps no wider than the narrowest source it read), decided
--    from the run's own source log and the data the lines point at, never from the scope label alone. The one decision `memory.retain` (via
--    memory-hindsight's `app.memory_run_scope()`) and the feed's run summaries both read.
--  * app.memory_authored_verdict(actor, at): the same rule for something a bot wrote without being asked to retain it (a message or a page it
--    posted during a run): the bot's runs that were open at that moment decide.
--
-- Ordering: the manifest's `dependsOn` puts this after channels, bots, files, approvals and repo-git. The functions are plpgsql, so the
-- tables they read are resolved when they run.

CREATE TABLE app.memory_retain_log (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  store         text NOT NULL DEFAULT 'team_bank' CHECK (store IN ('team_bank', 'person_file')),
  bank          text NOT NULL CHECK (char_length(bank) BETWEEN 1 AND 200),
  source_kind   text NOT NULL CHECK (source_kind IN ('message', 'thread', 'run', 'approval', 'page', 'run_tool')),
  source_id     text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 1100),
  -- the channel the source lives in, so a channel that stops being team-visible finds its documents; SET NULL keeps the line when it goes
  channel_id    uuid REFERENCES app.channels (id) ON DELETE SET NULL,
  document_id   text CHECK (document_id IS NULL OR char_length(document_id) <= 200),
  content_hash  text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  outcome       text NOT NULL CHECK (outcome IN ('retained', 'forgotten', 'withheld', 'not_configured', 'failed')),
  reason        text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  run_id        uuid REFERENCES app.bot_runs (id) ON DELETE SET NULL,
  source_scopes text[] NOT NULL DEFAULT '{}' CHECK (source_scopes <@ ARRAY['team', 'channel', 'person']),
  actor_id      uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  link          text NOT NULL DEFAULT '' CHECK (char_length(link) <= 1500),
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- the lookup of the newest line of one source (idempotency, replace, forget)
CREATE INDEX memory_retain_log_source ON app.memory_retain_log (source_kind, source_id, id DESC);
CREATE INDEX memory_retain_log_team ON app.memory_retain_log (team_id, id DESC);
-- "has this team had its day's not_configured line" (the feed writes at most one per team per day)
CREATE INDEX memory_retain_log_not_configured ON app.memory_retain_log (team_id, id DESC) WHERE outcome = 'not_configured';
CREATE INDEX memory_retain_log_channel ON app.memory_retain_log (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX memory_retain_log_run ON app.memory_retain_log (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX memory_retain_log_actor ON app.memory_retain_log (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX memory_retain_log_workspace ON app.memory_retain_log (workspace_id);
CREATE INDEX memory_retain_log_created_brin ON app.memory_retain_log USING brin (created_at);
COMMENT ON TABLE app.memory_retain_log IS 'rls: team — T: what the platform retained into, replaced in, forgot from or withheld from a team''s memory bank, and why; ids, hashes and reasons, never the text; readable by the team''s leads and workspace admins (manage), written by the system role and by the run''s own definer door.';

CREATE TABLE app.memory_feed_pending (
  source_kind    text NOT NULL,
  source_id      text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 1100),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  -- debounce, back-off and "the run has not closed yet" all push this out
  not_before     timestamptz NOT NULL DEFAULT now(),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  deferred_since timestamptz,
  last_error     text NOT NULL DEFAULT '' CHECK (char_length(last_error) <= 300),
  PRIMARY KEY (source_kind, source_id)
);
CREATE INDEX memory_feed_pending_due ON app.memory_feed_pending (not_before, requested_at);
CREATE INDEX memory_feed_pending_workspace ON app.memory_feed_pending (workspace_id);
COMMENT ON TABLE app.memory_feed_pending IS 'rls: system — S: the feed''s work list (sources that changed and have not been reconciled with the bank yet); no privilege for manythreads_app.';

-- Row level security ----------------------------------------------------------------------------------------------------
-- The set of teams is hoisted: one evaluation per statement, never one per row.
ALTER TABLE app.memory_retain_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_retain_log FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_retain_log_select ON app.memory_retain_log FOR SELECT USING (
  (SELECT app.is_system())
  OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]));
CREATE POLICY memory_retain_log_system ON app.memory_retain_log FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.memory_retain_log TO manythreads_app;
-- Append-only, like the event log: a line is never edited or removed by the system role either (what was decided stays as decided; the foreign
-- keys' own SET NULL / CASCADE run as the table owner).
REVOKE UPDATE, DELETE, TRUNCATE ON app.memory_retain_log FROM manythreads_system;

ALTER TABLE app.memory_feed_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_feed_pending FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_feed_pending_system ON app.memory_feed_pending FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: the work list is the platform's

-- The narrowest-source rule ----------------------------------------------------------------------------------------------
-- Answers one row for the run (none for an unknown run): why it may not add to its team's bank (null = it may), the narrowest scope it read
-- (`person` < `channel` < `team`), how many source lines it has and which scope labels they carried.
--
-- A line is team-visible when:
--   * `message`: it resolves to a message of a PUBLIC channel of the run's own team — whatever scope label the line carries (a label is a claim,
--     not a proof: a private or DM message logged as `team` is still private);
--   * `file`: it is labelled `team` (the gateway labels a file with no channel that way: a team file), or resolves to a file of a public channel
--     of the run's team;
--   * anything else (a memory bank, a page, ...): it is labelled `team`. A `channel`-labelled line of an unknown type cannot be shown to be
--     public, so it counts as narrower.
-- The refusals, in this order (the first that applies is the reason):
--   person_source   a line with scope `person`;
--   private_source  a line that is not team-visible (a private channel, a DM, a bot conversation, another team's channel, an unresolvable ref);
--   conversation    the run is a `conversation` run (a person talking to the bot);
--   private_channel the run answers in a channel (`bot_runs.channel_id`) that is not a public channel of its team (a run opened by an approval
--                   resume carries the approval's channel, so it is caught here too);
--   private_thread  the run's thread is in a channel that is not a public channel of its team.
-- SECURITY DEFINER owned by manythreads_system (a bot cannot read other people's channels or its own run's source lines); executable by the
-- system role only: the request role reaches it through `app.memory_run_scope()` (memory-hindsight), which answers for the caller's own live run.
CREATE FUNCTION app.run_retain_verdict(p_run uuid)
  RETURNS TABLE (retain_refusal text, narrowest_scope text, source_lines integer, source_scopes text[])
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r app.bot_runs%ROWTYPE;
  v_lines   integer;
  v_scopes  text[];
  v_person  integer;
  v_private integer;
  v_refusal text;
BEGIN
  SELECT * INTO r FROM app.bot_runs WHERE id = p_run;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer,
         coalesce(array_agg(DISTINCT s.scope ORDER BY s.scope), '{}'::text[]),
         (count(*) FILTER (WHERE s.scope = 'person'))::integer,
         (count(*) FILTER (WHERE s.narrow))::integer
    INTO v_lines, v_scopes, v_person, v_private
    FROM (
      SELECT l.scope,
             (l.scope <> 'person' AND NOT (
               CASE l.source_type
                 WHEN 'message' THEN EXISTS (
                   SELECT 1 FROM app.messages m JOIN app.channels c ON c.id = m.channel_id
                    WHERE m.id::text = l.source_ref AND c.kind = 'channel' AND NOT c.private AND c.team_id = r.team_id)
                 WHEN 'file' THEN l.scope = 'team' OR EXISTS (
                   SELECT 1 FROM app.files f JOIN app.channels c ON c.id = f.channel_id
                    WHERE f.id::text = l.source_ref AND c.kind = 'channel' AND NOT c.private AND c.team_id = r.team_id)
                 ELSE l.scope = 'team'
               END)) AS narrow
        FROM app.run_source_log l
       WHERE l.run_id = p_run
    ) s;

  v_refusal := CASE
    WHEN v_person > 0 THEN 'person_source'
    WHEN v_private > 0 THEN 'private_source'
    WHEN r.trigger_type = 'conversation' THEN 'conversation'
    WHEN r.channel_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM app.channels c WHERE c.id = r.channel_id AND c.kind = 'channel' AND NOT c.private AND c.team_id = r.team_id
    ) THEN 'private_channel'
    WHEN r.thread_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM app.threads th JOIN app.channels c ON c.id = th.channel_id
       WHERE th.root_message_id = r.thread_id AND c.kind = 'channel' AND NOT c.private AND c.team_id = r.team_id
    ) THEN 'private_thread'
    ELSE NULL
  END;

  RETURN QUERY SELECT
    v_refusal,
    CASE
      WHEN v_person > 0 OR v_refusal = 'conversation' THEN 'person'
      WHEN v_refusal IS NOT NULL THEN 'channel'
      ELSE 'team'
    END,
    v_lines,
    v_scopes;
END
$$;

ALTER FUNCTION app.run_retain_verdict(uuid) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.run_retain_verdict(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.run_retain_verdict(uuid) TO manythreads_system;
COMMENT ON FUNCTION app.run_retain_verdict(uuid) IS
  'The narrowest-source retain rule for one run: why it may not add to its team''s memory bank (null = it may), the narrowest scope it read, its source lines and their scope labels. System role only.';

-- What a bot wrote without being asked to retain it ------------------------------------------------------------------------
-- A message or a page a bot posted during a run is team-visible where it was posted, but the run that wrote it may have read something narrower;
-- the bank must not carry it then (it would outlive and out-reach the run's own scope). The bot's runs that were open at `p_at` (±2 s: git dates
-- have one-second resolution) decide: `retain_refusal` is the first refusal among them, `run_open` says a run is still going (its source log can
-- still grow, so the caller waits), `runs` how many there were (0: nothing was running, the bot wrote it outside a run). A run that never closed
-- covers two hours from its start and no more, so one lost worker cannot hold a bot's later messages back for ever.
CREATE FUNCTION app.memory_authored_verdict(p_bot_actor uuid, p_at timestamptz)
  RETURNS TABLE (run_open boolean, retain_refusal text, runs integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT coalesce(bool_or(r.ended_at IS NULL AND r.started_at + interval '2 hours' > now()), false),
         (array_agg(v.retain_refusal ORDER BY r.id) FILTER (WHERE v.retain_refusal IS NOT NULL))[1],
         count(r.id)::integer
    FROM app.actors a
    JOIN app.bot_runs r ON r.bot_id = a.ref_id AND r.workspace_id = a.workspace_id
    CROSS JOIN LATERAL app.run_retain_verdict(r.id) v
   WHERE a.id = p_bot_actor AND a.kind = 'bot'
     AND r.started_at <= p_at + interval '2 seconds'
     AND p_at - interval '2 seconds' <= coalesce(r.ended_at, r.started_at + interval '2 hours')
$$;

ALTER FUNCTION app.memory_authored_verdict(uuid, timestamptz) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.memory_authored_verdict(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_authored_verdict(uuid, timestamptz) TO manythreads_system;
COMMENT ON FUNCTION app.memory_authored_verdict(uuid, timestamptz) IS
  'The retain verdict for something a bot wrote at p_at: the first refusal among the bot''s runs that were open then, whether one still is, and how many there were. System role only.';
