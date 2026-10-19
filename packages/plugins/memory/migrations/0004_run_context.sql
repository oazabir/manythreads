-- memory plugin 0004: who a bot's `memory.write` commits for (PLAN P5-26; SPEC §12.1). Forward-only: never edit once applied.
--
-- A concept a bot writes names its producer in `generated.by` — `<bot slug>/<model alias>` (SPEC §12.1's `archivist/<alias>`) — and the commit's
-- author is the bot with the asking person as co-author. Those facts live in rows a bot may not read: `app.bot_runs` is visible to the run's own bot
-- but `app.bots` and `app.people` are team and workspace rows, and `app.actors` shows a caller only itself. So this definer function answers them
-- for the calling transaction's own live run, and for nothing else: `app.run_id()` is set only by the kernel's `withActor`, `app.actor()` is the
-- actor of that transaction, and the run must be that actor's own bot's run. Inside, `app.is_system()` is TRUE, so the identity is checked with
-- `app.actor()` and never with it (same trust base as memory-hindsight 0001 and memory 0002).
--
--  * `asker_kind` / `asker_name`: who asked (a person, usually; a delegated run's asker is a bot). The writer gets the name as a `Co-authored-by`
--    trailer only for a person — the plan's "the asking person as co-author".
--  * `bot_producer`: what `memory.write` stamps as `generated.by`. With no model alias the runtime name stands in (`<slug>/rules` for a rules bot),
--    so the value is always `<producer>/<version>` in the shared `OkfActor` vocabulary.
-- No new table: the answer is derived, and a run that is over or is somebody else's run yields no row.

CREATE FUNCTION app.memory_run_context()
  RETURNS TABLE (team_id uuid, asker_id uuid, asker_kind text, asker_name text, bot_slug text, bot_name text, bot_producer text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT r.team_id,
         r.asker_id,
         a.kind,
         CASE a.kind
           WHEN 'person' THEN p.display_name
           WHEN 'bot' THEN b2.name
           ELSE NULL
         END,
         b.slug,
         b.name,
         b.slug || '/' || coalesce(b.model_aliases[1], b.runtime)
    FROM app.bot_runs r
    JOIN app.bots b ON b.id = r.bot_id
    JOIN app.actors bot_actor ON bot_actor.kind = 'bot' AND bot_actor.ref_id = r.bot_id AND bot_actor.workspace_id = r.workspace_id
    LEFT JOIN app.actors a ON a.id = r.asker_id
    LEFT JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id
    LEFT JOIN app.bots b2 ON a.kind = 'bot' AND b2.id = a.ref_id
   WHERE r.id = app.run_id()
     AND r.status = 'running'
     AND r.ended_at IS NULL
     AND app.actor() = bot_actor.id;
$$;

ALTER FUNCTION app.memory_run_context() OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.memory_run_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_run_context() TO manythreads_app, manythreads_system;

COMMENT ON FUNCTION app.memory_run_context() IS
  'Who the calling transaction''s live run writes memory for (app.run_id(), set only by withActor): its team, the asker (id, kind, display name) and the bot''s slug and producer (`<slug>/<model alias>`). One row, only when app.actor() is that run''s bot; none otherwise.';
