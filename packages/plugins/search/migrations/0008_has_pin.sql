-- search 0008: `has:pin` (PLAN P31-07, P14-11). Forward-only: never edit once applied.
--
-- `app.search_messages` takes an eleventh argument, `p_has_pin` (default false, so every earlier call is unchanged). The function is otherwise the body of
-- 0004 word for word: same plans, same SECURITY INVOKER, same visibility. A pinned message is found only among the channels the caller already reads
-- (`v_vis`, narrowed by team and `in:`), and the pin rows themselves are read through `app.message_pins`'s read policy (channels 0020), so `has:pin`
-- only narrows. The ids are inlined as a typed literal with format(%L), like `p_from`, so the planner sees them; a channel keeps at most 100 pins.

DROP FUNCTION app.search_messages(text, uuid, integer, uuid[], uuid[], boolean, boolean, boolean, timestamptz, timestamptz);

CREATE FUNCTION app.search_messages(
  p_query text, p_team_id uuid, p_limit integer,
  p_from uuid[] DEFAULT NULL, p_in uuid[] DEFAULT NULL,
  p_has_file boolean DEFAULT false, p_has_link boolean DEFAULT false, p_in_thread boolean DEFAULT false,
  p_before timestamptz DEFAULT NULL, p_after timestamptz DEFAULT NULL,
  p_has_pin boolean DEFAULT false
) RETURNS SETOF app.search_message_hit
  LANGUAGE plpgsql STABLE
  SET pg_trgm.word_similarity_threshold = '0.5'
  SET gin_fuzzy_search_limit = 0
  SET enable_indexscan = off
AS $$
DECLARE
  v_limit   integer := least(greatest(coalesce(p_limit, 20), 1), 51);
  v_query   text    := btrim(coalesce(p_query, ''));
  v_text    boolean := length(btrim(coalesce(p_query, ''))) >= 2;
  v_vis     uuid[]  := app.visible_channel_ids('read');
  v_thr     real    := CASE WHEN cardinality(regexp_split_to_array(btrim(coalesce(p_query, '')), '\s+')) >= 3 THEN 0.6 ELSE 0.5 END;
  v_phrase  boolean := cardinality(regexp_split_to_array(btrim(coalesce(p_query, '')), '\s+')) >= 3;
  v_windows interval[];
  v_window  interval;
  v_small   integer;
  v_rows    app.search_message_hit[];
  v_sql     text;
  v_extra   text := ' AND m.deleted_at IS NULL';
  v_cols    text := $c$ROW(r.id, r.channel_id, r.author_id, r.thread_root_id, r.snippet, r.score, r.created_at)::app.search_message_hit$c$;
  v_select  text;
BEGIN
  -- the caller's readable channels, narrowed (never widened) by the team and by `in:`
  IF p_team_id IS NOT NULL THEN
    v_vis := ARRAY(SELECT c.id FROM app.channels c WHERE c.team_id = p_team_id AND c.id = ANY (v_vis));
  END IF;
  IF p_in IS NOT NULL THEN
    v_vis := ARRAY(SELECT x FROM unnest(v_vis) x WHERE x = ANY (p_in));
  END IF;
  IF cardinality(v_vis) = 0 THEN
    RETURN;
  END IF;

  IF p_from IS NOT NULL THEN
    IF cardinality(p_from) = 0 THEN RETURN; END IF;
    v_extra := v_extra || format(' AND m.author_id = ANY (%L::uuid[])', p_from);
  END IF;
  IF p_has_file THEN
    v_extra := v_extra || $e$ AND jsonb_typeof(m.meta -> 'attachments') = 'array' AND m.meta -> 'attachments' <> '[]'::jsonb$e$;
  END IF;
  IF p_has_link THEN
    v_extra := v_extra || $e$ AND m.body ~* 'https?://'$e$;
  END IF;
  IF p_has_pin THEN
    -- the pinned messages of the channels left in v_vis, read through the pins table's own read policy (channels 0020): at most 100 a channel
    v_extra := v_extra || format(' AND m.id = ANY (%L::uuid[])', ARRAY(SELECT p.message_id FROM app.message_pins p WHERE p.channel_id = ANY (v_vis)));
  END IF;
  IF p_in_thread THEN
    v_extra := v_extra || ' AND (m.thread_root_id IS NOT NULL OR EXISTS (SELECT 1 FROM app.threads t WHERE t.root_message_id = m.id))';
  END IF;
  IF p_before IS NOT NULL THEN
    v_extra := v_extra || format(' AND m.created_at < %L::timestamptz', p_before);
  END IF;
  IF p_after IS NOT NULL THEN
    v_extra := v_extra || format(' AND m.created_at >= %L::timestamptz', p_after);
  END IF;

  IF NOT v_text THEN
    -- filters only: newest first, by slices of recency so a busy workspace is answered from the last day
    v_select := $c$m.id, m.channel_id, m.author_id, m.thread_root_id, left(m.body_plain, 240) AS snippet, 0::real AS score, m.created_at$c$;
    v_sql := format($q$
      SELECT array_agg(%s ORDER BY r.id DESC)
        FROM (SELECT %s FROM app.messages m
               WHERE m.channel_id = ANY ($1) AND m.id >= $2 %s
               ORDER BY m.id DESC LIMIT $4) r$q$, v_cols, v_select, v_extra);
    FOREACH v_window IN ARRAY ARRAY['1 day', '16 days']::interval[] LOOP
      EXECUTE v_sql INTO v_rows USING v_vis, uuidv7(-v_window), NULL::text, v_limit;
      IF coalesce(cardinality(v_rows), 0) >= v_limit THEN
        RETURN QUERY SELECT * FROM unnest(v_rows);
        RETURN;
      END IF;
    END LOOP;
    EXECUTE v_sql INTO v_rows USING v_vis, '00000000-0000-0000-0000-000000000000'::uuid, NULL::text, v_limit;
    RETURN QUERY SELECT * FROM unnest(coalesce(v_rows, ARRAY[]::app.search_message_hit[]));
    RETURN;
  END IF;

  v_select := $c$m.id, m.channel_id, m.author_id, m.thread_root_id, left(m.body_plain, 240) AS snippet,
                 word_similarity($3, m.body_plain) AS score, m.created_at$c$;
  v_windows := CASE WHEN v_phrase THEN ARRAY[]::interval[] ELSE ARRAY['1 day', '16 days']::interval[] END;
  PERFORM set_config('pg_trgm.word_similarity_threshold', v_thr::text, true);   -- restored when the function returns

  -- a. a caller who reads little: compare every row, not through the index (`word_similarity(...) >= threshold` is what `%>` means)
  SELECT count(*) INTO v_small FROM (SELECT 1 FROM app.messages m WHERE m.channel_id = ANY (v_vis) LIMIT 6001) c;
  IF v_small <= 6000 THEN
    EXECUTE format($q$
      SELECT array_agg(%s ORDER BY r.score DESC, r.id DESC)
        FROM (SELECT %s FROM app.messages m
               WHERE m.channel_id = ANY ($1) AND word_similarity($3, m.body_plain) >= $5 %s
               ORDER BY 6 DESC, m.id DESC LIMIT $4) r$q$, v_cols, v_select, v_extra)
      INTO v_rows USING v_vis, NULL::uuid, v_query, v_limit, v_thr;
    RETURN QUERY SELECT * FROM unnest(coalesce(v_rows, ARRAY[]::app.search_message_hit[]));
    RETURN;
  END IF;

  -- b. newest slices through the trigram index; c. everything (EXECUTE: planned with the real values every time, the planner needs the real array)
  v_sql := format($q$
    SELECT array_agg(%s ORDER BY r.score DESC, r.id DESC)
      FROM (SELECT %s FROM app.messages m
             WHERE m.channel_id = ANY ($1) AND m.id >= $2 AND m.body_plain %%> $3 %s
             ORDER BY 6 DESC, m.id DESC LIMIT $4) r$q$, v_cols, v_select, v_extra);
  FOREACH v_window IN ARRAY v_windows LOOP
    EXECUTE v_sql INTO v_rows USING v_vis, uuidv7(-v_window), v_query, v_limit;
    IF coalesce(cardinality(v_rows), 0) >= v_limit THEN
      RETURN QUERY SELECT * FROM unnest(v_rows);
      RETURN;
    END IF;
  END LOOP;
  PERFORM set_config('gin_fuzzy_search_limit', CASE WHEN v_phrase THEN '3000' ELSE '30000' END, true);
  EXECUTE v_sql INTO v_rows USING v_vis, '00000000-0000-0000-0000-000000000000'::uuid, v_query, v_limit;
  RETURN QUERY SELECT * FROM unnest(coalesce(v_rows, ARRAY[]::app.search_message_hit[]));
END
$$;

REVOKE ALL ON FUNCTION app.search_messages(text, uuid, integer, uuid[], uuid[], boolean, boolean, boolean, timestamptz, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_messages(text, uuid, integer, uuid[], uuid[], boolean, boolean, boolean, timestamptz, timestamptz, boolean) TO manythreads_app, manythreads_system;
