-- search 0004: filters, pages, and who a name means (PLAN P14-11). Forward-only: never edit once applied.
--
-- What changes. The three search functions of 0001/0003 take filter arguments (all optional, so the calls of the capabilities and the older
-- tests are unchanged): who wrote it (`p_from`, actor ids), which channels (`p_in`), `has:file`, `has:link`, `is:thread`, and a time range.
-- The text may now be empty: a search that is only filters returns the newest matches first. A new function searches pages (Markdown files
-- under `pages/` of a team's repository, table `repo_entries` of repo-git), and a definer function turns a typed name into actor ids.
--
-- Security is unchanged and is the point. Every function stays SECURITY INVOKER and reads the same tables as the caller, so each row has
-- passed the same hoisted read policy as a plain SELECT. A filter can only NARROW: `p_in` is intersected with the caller's readable channel
-- set (`app.visible_channel_ids('read')`), never added to it; a channel id the caller passes that they cannot read is dropped before any
-- row is read. A filter argument is never part of the SQL text unquoted: it is inlined with format(%L) only as a typed literal, because the
-- planner needs the real values to choose the channel and trigram indexes (0001). Counting is by the same rule: the number of hits is the
-- number of rows returned, and no function here counts rows before the policy has run.
--
-- Pages: `repo_entries` is readable by whoever reads the team (repo-git 0001, hoisted team set). Its `text_plain` is bounded to 1 MiB and
-- `path` to 1024 characters by CHECK constraints, far below the size that makes a pg_trgm operator fail (search 0002), so the LEAKPROOF mark
-- stays honest for this table too. A page's time and author come from the commit that last changed it (`repo_commits`, same team policy).

DROP FUNCTION app.search_messages(text, uuid, integer);
DROP FUNCTION app.search_threads(text, uuid, integer);
DROP FUNCTION app.search_files(text, uuid, integer);

-- Messages ---------------------------------------------------------------------------------------------------------------------------
-- Plans (see 0001 for the reasoning), now with `v_extra`, the filter conditions, added to every plan:
--   text:        a. a caller who reads little compares every row; b. one or two words: the newest slices through the trigram index;
--                c. the whole history through the index (phrases go straight to c, 0003).
--   filters only: the same slices by recency (no trigram), then the whole history. A message is found newest first.
CREATE FUNCTION app.search_messages(
  p_query text, p_team_id uuid, p_limit integer,
  p_from uuid[] DEFAULT NULL, p_in uuid[] DEFAULT NULL,
  p_has_file boolean DEFAULT false, p_has_link boolean DEFAULT false, p_in_thread boolean DEFAULT false,
  p_before timestamptz DEFAULT NULL, p_after timestamptz DEFAULT NULL
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

-- Threads: a thread is found by its title (the start of its root message). `p_from` is the root's author, `p_in` the channel, the range the
-- last reply. `has:` and `is:thread` are not asked of this function (a thread hit is a thread already; the service leaves it out for `has:`).
CREATE FUNCTION app.search_threads(
  p_query text, p_team_id uuid, p_limit integer,
  p_from uuid[] DEFAULT NULL, p_in uuid[] DEFAULT NULL, p_before timestamptz DEFAULT NULL, p_after timestamptz DEFAULT NULL
) RETURNS TABLE (root_message_id uuid, channel_id uuid, title text, reply_count integer, score real, last_reply_at timestamptz)
  LANGUAGE plpgsql STABLE
  SET pg_trgm.word_similarity_threshold = '0.5'
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 51);
  v_query text    := btrim(coalesce(p_query, ''));
  v_vis   uuid[]  := app.visible_channel_ids('read');
BEGIN
  IF p_in IS NOT NULL THEN
    v_vis := ARRAY(SELECT x FROM unnest(v_vis) x WHERE x = ANY (p_in));
  END IF;
  IF p_team_id IS NOT NULL THEN
    v_vis := ARRAY(SELECT c.id FROM app.channels c WHERE c.team_id = p_team_id AND c.id = ANY (v_vis));
  END IF;
  IF cardinality(v_vis) = 0 OR (p_from IS NOT NULL AND cardinality(p_from) = 0) THEN
    RETURN;
  END IF;
  IF length(v_query) >= 2 THEN
    RETURN QUERY
    SELECT t.root_message_id, t.channel_id, t.title, t.reply_count, word_similarity(v_query, t.title), t.last_reply_at
      FROM app.threads t
     WHERE t.title %> v_query
       AND t.channel_id = ANY (v_vis)
       AND (p_before IS NULL OR t.last_reply_at < p_before)
       AND (p_after IS NULL OR t.last_reply_at >= p_after)
       AND (p_from IS NULL OR EXISTS (SELECT 1 FROM app.messages r WHERE r.id = t.root_message_id AND r.author_id = ANY (p_from)))
     ORDER BY 5 DESC, t.last_reply_at DESC
     LIMIT v_limit;
  ELSE
    RETURN QUERY
    SELECT t.root_message_id, t.channel_id, t.title, t.reply_count, 0::real, t.last_reply_at
      FROM app.threads t
     WHERE t.channel_id = ANY (v_vis)
       AND (p_before IS NULL OR t.last_reply_at < p_before)
       AND (p_after IS NULL OR t.last_reply_at >= p_after)
       AND (p_from IS NULL OR EXISTS (SELECT 1 FROM app.messages r WHERE r.id = t.root_message_id AND r.author_id = ANY (p_from)))
     ORDER BY t.last_reply_at DESC
     LIMIT v_limit;
  END IF;
END
$$;

-- Files: by name. `p_from` is the uploader, `p_in` the channel (a team file with no channel is left out by `in:`).
CREATE FUNCTION app.search_files(
  p_query text, p_team_id uuid, p_limit integer,
  p_from uuid[] DEFAULT NULL, p_in uuid[] DEFAULT NULL, p_before timestamptz DEFAULT NULL, p_after timestamptz DEFAULT NULL
) RETURNS TABLE (id uuid, channel_id uuid, folder_path text, name text, size bigint, mime text, score real, created_at timestamptz)
  LANGUAGE plpgsql STABLE
  SET pg_trgm.word_similarity_threshold = '0.4'
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 51);
  v_query text    := btrim(coalesce(p_query, ''));
BEGIN
  IF (p_from IS NOT NULL AND cardinality(p_from) = 0) OR (p_in IS NOT NULL AND cardinality(p_in) = 0) THEN
    RETURN;
  END IF;
  IF length(v_query) >= 2 THEN
    RETURN QUERY
    SELECT f.id, f.channel_id, f.folder_path, f.name, f.size, f.mime, word_similarity(v_query, f.name), f.created_at
      FROM app.files f
     WHERE f.name %> v_query
       AND (p_team_id IS NULL OR f.team_id = p_team_id)
       AND (p_from IS NULL OR f.uploader_id = ANY (p_from))
       AND (p_in IS NULL OR f.channel_id = ANY (p_in))
       AND (p_before IS NULL OR f.created_at < p_before)
       AND (p_after IS NULL OR f.created_at >= p_after)
     ORDER BY 7 DESC, f.id DESC
     LIMIT v_limit;
  ELSE
    RETURN QUERY
    SELECT f.id, f.channel_id, f.folder_path, f.name, f.size, f.mime, 0::real, f.created_at
      FROM app.files f
     WHERE (p_team_id IS NULL OR f.team_id = p_team_id)
       AND (p_from IS NULL OR f.uploader_id = ANY (p_from))
       AND (p_in IS NULL OR f.channel_id = ANY (p_in))
       AND (p_before IS NULL OR f.created_at < p_before)
       AND (p_after IS NULL OR f.created_at >= p_after)
     ORDER BY f.id DESC
     LIMIT v_limit;
  END IF;
END
$$;

-- Pages: Markdown files under `pages/` of the teams the caller can read (the policy of repo_entries). Matched on the file name and on the text.
-- `p_from` is the person who last saved the page, the range its last save. No channel, so `in:` never reaches here (the service skips the call).
-- `enable_seqscan = off`: the planner cannot estimate `%>` and prefers a sequential scan that compares the text of every file of every team the
-- caller reads (measured: the GIN indexes ARE usable behind the policy, search-rls test); the filter-only branch has no index qual and still scans.
CREATE FUNCTION app.search_pages(
  p_query text, p_team_id uuid, p_limit integer,
  p_from uuid[] DEFAULT NULL, p_before timestamptz DEFAULT NULL, p_after timestamptz DEFAULT NULL
) RETURNS TABLE (team_id uuid, path text, snippet text, score real, updated_at timestamptz)
  LANGUAGE plpgsql STABLE
  SET pg_trgm.word_similarity_threshold = '0.5'
  SET enable_seqscan = off
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 51);
  v_query text    := btrim(coalesce(p_query, ''));
BEGIN
  IF p_from IS NOT NULL AND cardinality(p_from) = 0 THEN
    RETURN;
  END IF;
  IF length(v_query) >= 2 THEN
    RETURN QUERY
    SELECT e.team_id, e.path, left(coalesce(e.text_plain, ''), 240),
           greatest(word_similarity(v_query, e.path), word_similarity(v_query, coalesce(e.text_plain, '')))::real,
           c.committed_at
      FROM app.repo_entries e
      JOIN app.repo_commits c ON c.team_id = e.team_id AND c.sha = e.last_commit_sha
     WHERE starts_with(e.path, 'pages/')
       AND (e.text_plain %> v_query OR e.path %> v_query)
       AND (p_team_id IS NULL OR e.team_id = p_team_id)
       AND (p_from IS NULL OR c.author_id = ANY (p_from))
       AND (p_before IS NULL OR c.committed_at < p_before)
       AND (p_after IS NULL OR c.committed_at >= p_after)
     ORDER BY 4 DESC, c.committed_at DESC
     LIMIT v_limit;
  ELSE
    RETURN QUERY
    SELECT e.team_id, e.path, left(coalesce(e.text_plain, ''), 240), 0::real, c.committed_at
      FROM app.repo_entries e
      JOIN app.repo_commits c ON c.team_id = e.team_id AND c.sha = e.last_commit_sha
     WHERE starts_with(e.path, 'pages/')
       AND (p_team_id IS NULL OR e.team_id = p_team_id)
       AND (p_from IS NULL OR c.author_id = ANY (p_from))
       AND (p_before IS NULL OR c.committed_at < p_before)
       AND (p_after IS NULL OR c.committed_at >= p_after)
     ORDER BY c.committed_at DESC, e.path
     LIMIT v_limit;
  END IF;
END
$$;

-- Who a typed name means ------------------------------------------------------------------------------------------------------------
-- `actors` shows a caller only their own row (kernel 0001), so `from:nadia` cannot be resolved from the app role's SQL (MISTAKES P3-07, P5-20).
-- This definer function answers, for each name, the actors of the people the caller may know by name: everyone in the workspace for an owner,
-- admin or member (the `people_select` policy says the same), only the caller for a guest. `me` is the caller. A name matches the start of the
-- display name or the start of any later word of it ("hamdan" finds "Nadia Hamdan"), case-insensitively, as plain text (no wildcard). A bot
-- has no display name in the database (it lives in BOT.md), so a bot is not found by name. At most 10 names, 20 matches per name; the caller is
-- checked with lookup_workspace_role (inside this function app.is_system() is TRUE, MISTAKES P2 review).
CREATE FUNCTION app.search_resolve_people(p_names text[]) RETURNS TABLE (name_key text, actor_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_role text := app.lookup_workspace_role();
  v_ws   uuid := app.workspace_id();
  v_self uuid := app.actor();
BEGIN
  IF v_self IS NULL OR v_role IS NULL OR v_ws IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT n.key, m.id
    FROM (SELECT DISTINCT lower(btrim(x)) AS key FROM unnest(p_names[1:10]) x WHERE btrim(x) <> '') n
    CROSS JOIN LATERAL (
      SELECT a.id
        FROM app.actors a
        JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id
       WHERE a.kind = 'person' AND a.workspace_id = v_ws
         AND (
           (n.key = 'me' AND a.id = v_self)
           OR (n.key <> 'me' AND (v_role IN ('owner', 'admin', 'member') OR a.id = v_self)
               AND (starts_with(lower(p.display_name), n.key) OR strpos(lower(p.display_name), ' ' || n.key) > 0))
         )
       ORDER BY a.id
       LIMIT 20
    ) m;
END
$$;

REVOKE ALL ON FUNCTION app.search_messages(text, uuid, integer, uuid[], uuid[], boolean, boolean, boolean, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.search_threads(text, uuid, integer, uuid[], uuid[], timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.search_files(text, uuid, integer, uuid[], uuid[], timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.search_pages(text, uuid, integer, uuid[], timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.search_resolve_people(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_messages(text, uuid, integer, uuid[], uuid[], boolean, boolean, boolean, timestamptz, timestamptz) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.search_threads(text, uuid, integer, uuid[], uuid[], timestamptz, timestamptz) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.search_files(text, uuid, integer, uuid[], uuid[], timestamptz, timestamptz) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.search_pages(text, uuid, integer, uuid[], timestamptz, timestamptz) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.search_resolve_people(text[]) TO manythreads_app;

-- The definer function is owned by the system role (its reads of actors and people pass their policies); the owner role gives it away and
-- takes CREATE back, as in every migration that does this (files 0001).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.search_resolve_people(text[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
