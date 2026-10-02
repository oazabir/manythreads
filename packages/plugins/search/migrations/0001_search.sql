-- search 0001: trigram search over messages, threads and files (PLAN.md P3-10; SPEC section 12). Forward-only.
--
-- No table of its own: the indexes already exist (messages.body_plain, threads.title, files.name, all GIN gin_trgm_ops). What this adds is the
-- three SQL functions the routes call, and one planner fact (below). The functions are SECURITY INVOKER on purpose: they run as the caller, so
-- every row they read is filtered by the hoisted read policies of the tables (`channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])`)
-- exactly as a plain SELECT would be. Search has no visibility rule of its own, so it cannot disagree with the rest of the product.
--
-- 1. The match is `word_similarity` (the `%>` operator, column on the left so the GIN index can answer it): "the query is similar to some run of
--    words of the text". Plain `similarity` / `%` compares the query with the WHOLE text, which a 7-letter typo never reaches against a 200-character
--    message. `pg_trgm.word_similarity_threshold` decides what `%>` accepts; it is set per function (a function's SET clause) because a plugin
--    transaction may not run SET itself.
--
-- 2. LEAKPROOF. A row level security policy is a security barrier: the planner may only hand a user qual to an index if its function is LEAKPROOF
--    (cannot leak its arguments through an error), otherwise it must run the policy first, row by row, and falls back to a sequential scan. pg_trgm's
--    operators never fail on any text and reveal nothing but their boolean, so they qualify, but pg_trgm ships them as plain functions (this is the
--    "trigram under RLS is not index-driven" finding of docs/retro/bench-phase-1.md: 2.3 s for 300,000 rows, a sequential scan with the GIN index
--    present). Marking them needs a superuser; the owner role is one in compose and on CloudNativePG (MISTAKES P1-13). Without the privilege search
--    still works, only slowly: the migration warns and goes on.
DO $$
BEGIN
  ALTER FUNCTION word_similarity_op(text, text) LEAKPROOF;
  ALTER FUNCTION word_similarity_commutator_op(text, text) LEAKPROOF;
  ALTER FUNCTION similarity_op(text, text) LEAKPROOF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'search: could not mark the pg_trgm operators LEAKPROOF (needs a superuser); trigram search under row level security will scan sequentially';
END
$$;

-- 3. Messages: why the search is windowed. A common word matches tens of thousands of messages; ranking all of them costs a heap fetch and a
--    trigram comparison each (1.6 s at 1,000,000 messages, docs/retro/phase-3.md). So the newest slice of history is searched first (one day, then
--    4, 16, 64, 256 days, then everything) and the first slice holding `limit` hits is ranked and returned: a common word is answered from the
--    last day, a rare one from the whole index (which is cheap because it has few entries). Within a slice, hits are ordered by similarity, then newest.
--    Each slice is a BitmapAnd of the trigram index, the (channel_id, id) index (`channel_id = ANY(visible set)` is repeated here as a plain qual so
--    a guest with one channel reads one channel's rows, not every candidate) and the primary key range (uuid v7 ids carry the time). Plain index scans
--    are switched off for the function because the planner mistakes `%>` for a cheap filter and walks the key range row by row (1.3 s).
--    The policies still apply on top: the repeated predicate only helps the planner, it never grants anything.
CREATE TYPE app.search_message_hit AS (
  id uuid, channel_id uuid, author_id uuid, thread_root_id uuid, snippet text, score real, created_at timestamptz
);

CREATE FUNCTION app.search_messages(p_query text, p_team_id uuid, p_limit integer) RETURNS SETOF app.search_message_hit
  LANGUAGE plpgsql STABLE
  SET pg_trgm.word_similarity_threshold = '0.5'
  SET enable_indexscan = off
AS $$
DECLARE
  v_limit   integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_vis     uuid[]  := app.visible_channel_ids('read');
  v_windows interval[] := ARRAY['1 day', '4 days', '16 days', '64 days', '256 days']::interval[];
  v_window  interval;
  v_rows    app.search_message_hit[];
  v_sql     text;
BEGIN
  IF p_team_id IS NOT NULL THEN
    v_vis := ARRAY(SELECT c.id FROM app.channels c WHERE c.team_id = p_team_id AND c.id = ANY (v_vis));
  END IF;
  IF cardinality(v_vis) = 0 THEN
    RETURN;
  END IF;
  -- EXECUTE (planned with the real values every time): the planner needs to see a one-element array to prefer the channel index.
  v_sql := $q$
    SELECT array_agg(ROW(r.id, r.channel_id, r.author_id, r.thread_root_id, r.snippet, r.score, r.created_at)::app.search_message_hit
                     ORDER BY r.score DESC, r.id DESC)
      FROM (SELECT m.id, m.channel_id, m.author_id, m.thread_root_id, left(m.body_plain, 240) AS snippet,
                   word_similarity($3, m.body_plain) AS score, m.created_at
              FROM app.messages m
             WHERE m.channel_id = ANY ($1) AND m.id >= $2 AND m.body_plain %> $3
             ORDER BY 6 DESC, m.id DESC LIMIT $4) r
  $q$;
  FOREACH v_window IN ARRAY v_windows LOOP
    EXECUTE v_sql INTO v_rows USING v_vis, uuidv7(-v_window), p_query, v_limit;
    IF coalesce(cardinality(v_rows), 0) >= v_limit THEN
      RETURN QUERY SELECT * FROM unnest(v_rows);
      RETURN;
    END IF;
  END LOOP;
  -- Fewer than `limit` hits in the last 256 days: the whole history (few candidates, or the window loop would have stopped).
  EXECUTE v_sql INTO v_rows USING v_vis, '00000000-0000-0000-0000-000000000000'::uuid, p_query, v_limit;
  RETURN QUERY SELECT * FROM unnest(coalesce(v_rows, ARRAY[]::app.search_message_hit[]));
END
$$;

-- Threads (one row per thread, a fraction of the messages) and files are small enough to rank everything the index returns.
CREATE FUNCTION app.search_threads(p_query text, p_team_id uuid, p_limit integer)
RETURNS TABLE (root_message_id uuid, channel_id uuid, title text, reply_count integer, score real, last_reply_at timestamptz)
  LANGUAGE sql STABLE
  SET pg_trgm.word_similarity_threshold = '0.5'
AS $$
  SELECT t.root_message_id, t.channel_id, t.title, t.reply_count, word_similarity(p_query, t.title), t.last_reply_at
    FROM app.threads t
   WHERE t.title %> p_query
     AND (p_team_id IS NULL OR t.channel_id IN (SELECT c.id FROM app.channels c WHERE c.team_id = p_team_id))
   ORDER BY 5 DESC, t.last_reply_at DESC
   LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

CREATE FUNCTION app.search_files(p_query text, p_team_id uuid, p_limit integer)
RETURNS TABLE (id uuid, channel_id uuid, folder_path text, name text, size bigint, mime text, score real, created_at timestamptz)
  LANGUAGE sql STABLE
  SET pg_trgm.word_similarity_threshold = '0.4'
AS $$
  SELECT f.id, f.channel_id, f.folder_path, f.name, f.size, f.mime, word_similarity(p_query, f.name), f.created_at
    FROM app.files f
   WHERE f.name %> p_query
     AND (p_team_id IS NULL OR f.team_id = p_team_id)
   ORDER BY 7 DESC, f.id DESC
   LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

REVOKE ALL ON FUNCTION app.search_messages(text, uuid, integer), app.search_threads(text, uuid, integer), app.search_files(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_messages(text, uuid, integer), app.search_threads(text, uuid, integer), app.search_files(text, uuid, integer)
  TO manythreads_app, manythreads_system;
