-- search 0003: a phrase is answered by one scan of the trigram index, not a one-day slice and then the whole history. Forward-only.
--
-- 0001 searched the newest day first for every query and fell back to the whole history when the day held fewer than `limit` hits. A single
-- word is cheap to scan twice, but a phrase of three words or more pays about 100 ms for the trigram index scan each time (1,000,000 rows), so
-- a phrase that matches only a few messages (the usual case: at the 0.6 threshold a phrase is selective) paid for two scans, and the phrase
-- was the case that put each persona's p95 on the 300 ms line (docs/retro/phase-3.md: 296 ms, then 302 ms in the gate run). Now a phrase goes
-- straight to the whole history through the index, ranked by similarity then newest; `gin_fuzzy_search_limit` is 3,000 for it (30,000 for a word),
-- so a phrase made of words most messages share is answered from a sample of the index rows instead of ranking tens of thousands of them. Same
-- security as 0001: the function runs as the caller, every policy applies on top of the plan, nothing here grants anything.
CREATE OR REPLACE FUNCTION app.search_messages(p_query text, p_team_id uuid, p_limit integer) RETURNS SETOF app.search_message_hit
  LANGUAGE plpgsql STABLE
  SET pg_trgm.word_similarity_threshold = '0.5'
  SET gin_fuzzy_search_limit = 0
  SET enable_indexscan = off
AS $$
DECLARE
  v_limit   integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_vis     uuid[]  := app.visible_channel_ids('read');
  v_thr     real    := CASE WHEN cardinality(regexp_split_to_array(btrim(p_query), '\s+')) >= 3 THEN 0.6 ELSE 0.5 END;
  v_phrase  boolean := cardinality(regexp_split_to_array(btrim(p_query), '\s+')) >= 3;
  v_windows interval[] := CASE WHEN cardinality(regexp_split_to_array(btrim(p_query), '\s+')) >= 3
                               THEN ARRAY[]::interval[] ELSE ARRAY['1 day', '16 days']::interval[] END;
  v_window  interval;
  v_small   integer;
  v_rows    app.search_message_hit[];
  v_sql     text;
  v_cols    text := $c$ROW(r.id, r.channel_id, r.author_id, r.thread_root_id, r.snippet, r.score, r.created_at)::app.search_message_hit$c$;
  v_select  text := $c$m.id, m.channel_id, m.author_id, m.thread_root_id, left(m.body_plain, 240) AS snippet,
                       word_similarity($3, m.body_plain) AS score, m.created_at$c$;
BEGIN
  IF p_team_id IS NOT NULL THEN
    v_vis := ARRAY(SELECT c.id FROM app.channels c WHERE c.team_id = p_team_id AND c.id = ANY (v_vis));
  END IF;
  IF cardinality(v_vis) = 0 THEN
    RETURN;
  END IF;
  PERFORM set_config('pg_trgm.word_similarity_threshold', v_thr::text, true);   -- restored when the function returns

  -- a. a caller who reads little: compare every row, not through the index (`word_similarity(...) >= threshold` is what `%>` means)
  SELECT count(*) INTO v_small FROM (SELECT 1 FROM app.messages m WHERE m.channel_id = ANY (v_vis) LIMIT 6001) c;
  IF v_small <= 6000 THEN
    EXECUTE format($q$
      SELECT array_agg(%s ORDER BY r.score DESC, r.id DESC)
        FROM (SELECT %s FROM app.messages m
               WHERE m.channel_id = ANY ($1) AND word_similarity($3, m.body_plain) >= $5
               ORDER BY 6 DESC, m.id DESC LIMIT $4) r$q$, v_cols, v_select)
      INTO v_rows USING v_vis, NULL::uuid, p_query, v_limit, v_thr;
    RETURN QUERY SELECT * FROM unnest(coalesce(v_rows, ARRAY[]::app.search_message_hit[]));
    RETURN;
  END IF;

  -- b. newest slices through the trigram index; c. everything (EXECUTE: planned with the real values every time, the planner needs the real array)
  v_sql := format($q$
    SELECT array_agg(%s ORDER BY r.score DESC, r.id DESC)
      FROM (SELECT %s FROM app.messages m
             WHERE m.channel_id = ANY ($1) AND m.id >= $2 AND m.body_plain %%> $3
             ORDER BY 6 DESC, m.id DESC LIMIT $4) r$q$, v_cols, v_select);
  FOREACH v_window IN ARRAY v_windows LOOP
    EXECUTE v_sql INTO v_rows USING v_vis, uuidv7(-v_window), p_query, v_limit;
    IF coalesce(cardinality(v_rows), 0) >= v_limit THEN
      RETURN QUERY SELECT * FROM unnest(v_rows);
      RETURN;
    END IF;
  END LOOP;
  PERFORM set_config('gin_fuzzy_search_limit', CASE WHEN v_phrase THEN '3000' ELSE '30000' END, true);
  EXECUTE v_sql INTO v_rows USING v_vis, '00000000-0000-0000-0000-000000000000'::uuid, p_query, v_limit;
  RETURN QUERY SELECT * FROM unnest(coalesce(v_rows, ARRAY[]::app.search_message_hit[]));
END
$$;

REVOKE ALL ON FUNCTION app.search_messages(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_messages(text, uuid, integer) TO manythreads_app, manythreads_system;
