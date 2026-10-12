-- memory-hindsight 0001: the door through which a run finds its memory bank (PLAN P5-12, SPEC 12.1). Not applied anywhere yet, so edited in place
-- by the P5-12 review; forward-only from the first deploy on.
--
-- A bot cannot name a bank; the platform derives it. The derivation is a database fact, not a parameter: `app.memory_run_scope()` answers for
-- the ONE run the calling transaction carries (`app.run_id()`) and for nothing else, with the team that run was opened for (the pairing token
-- fixed it) and the workspace and team slugs the bank is named from.
--
--  * TRUST BASE. `app.run_id()` and `app.actor()` read the settings `app.run_id` / `app.actor_id`. Those are set ONLY by the kernel's `withActor`
--    (`set_config(..., true)` at the start of each transaction); plugin SQL cannot set them, because `guardPluginTx` / `assertSafePluginSql`
--    rejects `set_config`, `SET`, `RESET` and `SET ROLE` in every plugin transaction (docs/plugins/security.md says this is a stopgap, not a
--    sandbox: the real defence is that plugins hold no raw connection). If a plugin ever gets one, this function (like `run_source_log_append`)
--    can be pointed at another run, and the plugin could read that run's team bank: the isolation here is exactly as strong as that boundary.
--  * It answers only while the run is live (`status = 'running'`, `ended_at IS NULL`).
--  * It answers only when `app.actor()` is the run's bot or the person who asked (the pair the run service sets).
--  * `retain_refusal` is null when the run may add to the team bank, else why not (SPEC 12.1: private channels, DMs and person runs are never
--    retained). Until P5-13's narrowest-source rule it is the conservative form: a run may retain only if EVERY line of its source log is provably
--    team-visible AND the run itself was not started in a private context:
--      - `person_source`   a source line with scope `person`;
--      - `private_source`  a `channel`-scoped line that is not a message/file of a PUBLIC channel of the run's own team (a private channel, a DM, a
--                          bot conversation, another team's channel, or a ref that does not resolve all count as private);
--      - `conversation`    the run was a `conversation` run (a person talking to the bot: the asker's own context, usually a bot DM);
--      - `private_thread`  the run's thread is in a channel that is not a public channel of its team.
--    Lines with scope `team` (a memory bank, a team file) are team-visible by construction (the gateway assigns the scope from the hit).
--  * SECURITY DEFINER owned by manythreads_system, like `app.run_source_log_append`, because a bot cannot read its own run's source lines or other
--    people's channels. Inside, `app.is_system()` is TRUE, so the caller is checked with `app.actor()` above and never with it.
--    plpgsql so the tables of the channels and files plugins are resolved when it runs, not when it is created.
-- No table: this plugin keeps no state of its own (the bank lives in Hindsight; what was retained is P5-13's `memory_retain_log`).

CREATE FUNCTION app.memory_run_scope()
  RETURNS TABLE (run_id uuid, team_id uuid, team_slug text, workspace_slug text, workspace_id uuid, bot_id uuid, retain_refusal text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT r.id, r.team_id, t.slug, w.slug, r.workspace_id, r.bot_id,
         CASE
           WHEN EXISTS (SELECT 1 FROM app.run_source_log l WHERE l.run_id = r.id AND l.scope = 'person') THEN 'person_source'
           WHEN EXISTS (
             SELECT 1 FROM app.run_source_log l
              WHERE l.run_id = r.id AND l.scope = 'channel'
                AND NOT (
                  (l.source_type = 'message' AND EXISTS (
                     SELECT 1 FROM app.messages m JOIN app.channels c ON c.id = m.channel_id
                      WHERE m.id::text = l.source_ref AND c.kind = 'channel' AND NOT c.private AND c.team_id = r.team_id))
                  OR (l.source_type = 'file' AND EXISTS (
                     SELECT 1 FROM app.files f JOIN app.channels c ON c.id = f.channel_id
                      WHERE f.id::text = l.source_ref AND c.kind = 'channel' AND NOT c.private AND c.team_id = r.team_id))
                )
           ) THEN 'private_source'
           WHEN r.trigger_type = 'conversation' THEN 'conversation'
           WHEN r.thread_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM app.threads th JOIN app.channels c ON c.id = th.channel_id
              WHERE th.root_message_id = r.thread_id AND c.kind = 'channel' AND NOT c.private AND c.team_id = r.team_id
           ) THEN 'private_thread'
           ELSE NULL
         END
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

COMMENT ON FUNCTION app.memory_run_scope() IS
  'The memory scope of the calling transaction''s live run (app.run_id(), set only by withActor): team, workspace and team slugs, bot, and why the run may not retain to the team bank (null = it may). No row for any other transaction.';
