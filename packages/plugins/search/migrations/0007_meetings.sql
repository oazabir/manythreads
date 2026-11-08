-- search 0007: what was said in meetings (PLAN P15-13). Forward-only: never edit once applied.
--
-- Two kinds of text are searched, both with the trigram indexes that meetings 0003 put on them (`meeting_segments.text`, `meeting_notes.notes_md`): a transcript line and a
-- meeting's notes. The function is SECURITY INVOKER like the others of this plugin: it runs as the caller, so every row it reads has passed the read policies of
-- `meetings`, `meeting_segments`, `meeting_participants` and `meeting_notes` (whoever can read the room's channel, or its team when it has none; the notes of a Personal
-- copy only for the organizer). Search has no visibility rule of its own for these tables, so it cannot disagree with the transcript screen. Three things are added on top
-- of the policies, all of them narrowing, none widening:
--
--   * a line counts only when its speaker's answer to "Transcribe my voice" is yes NOW (the same rule `renderTranscript` applies); a line stored without words is not text;
--   * a note-taker's transcript sits in the organizer's Personal space until they save or share it: `app.meeting_privacy` says so (see below) and the lines of such a
--     meeting are the organizer's alone;
--   * the filters (`team`, `from:`, `in:`, `before:`, `after:`) can only narrow.
--
-- The text columns are bounded far below the size at which a pg_trgm operator fails (search 0002): a line to 4,000 characters, the notes to 200,000.

-- Who a meeting's words belong to ---------------------------------------------------------------------------------------------------------
-- 'personal': the transcript and notes are the organizer's own until saved to the team (a note-taker meeting: its notes row is in the Personal location and not saved, or the
-- room has a note-taker and its notes row does not exist yet). Anything else is 'none': the readers of the room read the words. A definer function because the notes row of a
-- Personal copy is invisible to everyone but the organizer, so a reader's own query cannot tell "no notes" from "private notes". It answers about a meeting of the caller's
-- workspace only and returns nothing else, so a caller learns nothing they could not already see of a room they read.
CREATE FUNCTION app.meeting_privacy(p_meeting_id uuid) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  -- `record`, not the tables' row types: a database that carries the search plugin without the meetings plugin's tables must still accept this migration
  n record;
  m record;
BEGIN
  IF app.actor() IS NULL OR app.workspace_id() IS NULL THEN
    RETURN 'none';
  END IF;
  SELECT * INTO m FROM app.meetings WHERE id = p_meeting_id AND workspace_id = app.workspace_id();
  IF NOT FOUND THEN
    RETURN 'none';
  END IF;
  SELECT * INTO n FROM app.meeting_notes WHERE meeting_id = m.id;
  IF FOUND THEN
    RETURN CASE WHEN n.location = 'personal' AND n.saved_at IS NULL THEN 'personal' ELSE 'none' END;
  END IF;
  RETURN CASE WHEN m.notetaker_bot_id IS NOT NULL THEN 'personal' ELSE 'none' END;
END
$$;
REVOKE ALL ON FUNCTION app.meeting_privacy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meeting_privacy(uuid) TO manythreads_app, manythreads_system;

-- A few words around the first word of the query, so the reader sees why a line was found. Whitespace collapsed; at most 240 characters.
CREATE FUNCTION app.search_meeting_snippet(p_text text, p_query text) RETURNS text
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT regexp_replace(
    CASE
      WHEN char_length(p_text) <= 240 THEN p_text
      ELSE substr(p_text, greatest(coalesce(nullif(strpos(lower(p_text), lower(split_part(btrim(p_query), ' ', 1))), 0), 1) - 60, 1), 240)
    END, '\s+', ' ', 'g')
$$;

-- The search -----------------------------------------------------------------------------------------------------------------------------
CREATE TYPE app.search_meeting_hit AS (
  meeting_id uuid, title text, team_id uuid, channel_id uuid, at_ms integer, speaker_id uuid, speaker_name text,
  snippet text, in_notes boolean, score real, started_at timestamptz
);

-- Best match first (word similarity), then the newest meeting, then the earliest line. `p_from` (actor ids) keeps only lines those people spoke, so it leaves the notes out;
-- `p_in` keeps the meetings of those channels. A text under two characters finds nothing.
CREATE FUNCTION app.search_meetings(
  p_query text, p_team_id uuid, p_limit integer,
  p_from uuid[] DEFAULT NULL, p_in uuid[] DEFAULT NULL, p_before timestamptz DEFAULT NULL, p_after timestamptz DEFAULT NULL
) RETURNS SETOF app.search_meeting_hit
  LANGUAGE plpgsql STABLE
  SET pg_trgm.word_similarity_threshold = '0.5'
  SET gin_fuzzy_search_limit = 0
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 51);
  v_query text    := btrim(coalesce(p_query, ''));
  v_me    uuid    := app.actor();
  v_thr   real    := CASE WHEN cardinality(regexp_split_to_array(btrim(coalesce(p_query, '')), '\s+')) >= 3 THEN 0.6 ELSE 0.5 END;
BEGIN
  IF char_length(v_query) < 2 THEN
    RETURN;
  END IF;
  IF (p_from IS NOT NULL AND cardinality(p_from) = 0) OR (p_in IS NOT NULL AND cardinality(p_in) = 0) THEN
    RETURN;
  END IF;
  PERFORM set_config('pg_trgm.word_similarity_threshold', v_thr::text, true);   -- restored when the function returns

  RETURN QUERY
  SELECT r.meeting_id, r.title, r.team_id, r.channel_id, r.at_ms, r.speaker_id, r.speaker_name, r.snippet, r.in_notes, r.score, r.started_at
    FROM (
      (SELECT s.meeting_id, m.title, m.team_id, m.channel_id, s.start_ms AS at_ms, s.speaker_id, p.display_name AS speaker_name,
              app.search_meeting_snippet(s.text, v_query) AS snippet, false AS in_notes, word_similarity(v_query, s.text) AS score, m.started_at
         FROM app.meeting_segments s
         JOIN app.meetings m ON m.id = s.meeting_id
         JOIN app.meeting_participants p ON p.meeting_id = s.meeting_id AND p.actor_id = s.speaker_id
        WHERE s.text %> v_query AND s.final AND s.text <> ''
          AND p.consent_transcribe = 'yes'
          AND (p_team_id IS NULL OR m.team_id = p_team_id)
          AND (p_from IS NULL OR s.speaker_id = ANY (p_from))
          AND (p_in IS NULL OR m.channel_id = ANY (p_in))
          AND (p_before IS NULL OR m.started_at < p_before)
          AND (p_after IS NULL OR m.started_at >= p_after)
          AND (m.organizer_id = v_me OR app.meeting_privacy(m.id) = 'none')
        ORDER BY 10 DESC, m.started_at DESC, s.start_ms
        LIMIT v_limit)
      UNION ALL
      (SELECT n.meeting_id, m.title, m.team_id, m.channel_id, 0 AS at_ms, NULL::uuid AS speaker_id, NULL::text AS speaker_name,
              app.search_meeting_snippet(n.notes_md, v_query) AS snippet, true AS in_notes, word_similarity(v_query, n.notes_md) AS score, m.started_at
         FROM app.meeting_notes n
         JOIN app.meetings m ON m.id = n.meeting_id
        WHERE p_from IS NULL
          AND n.notes_md %> v_query AND n.notes_md <> ''
          AND (n.location <> 'personal' OR n.saved_at IS NOT NULL OR n.organizer_id = v_me)
          AND (p_team_id IS NULL OR m.team_id = p_team_id)
          AND (p_in IS NULL OR m.channel_id = ANY (p_in))
          AND (p_before IS NULL OR m.started_at < p_before)
          AND (p_after IS NULL OR m.started_at >= p_after)
        ORDER BY 10 DESC, m.started_at DESC
        LIMIT v_limit)
    ) r
   ORDER BY r.score DESC, r.started_at DESC, r.at_ms, r.in_notes
   LIMIT v_limit;
END
$$;

REVOKE ALL ON FUNCTION app.search_meetings(text, uuid, integer, uuid[], uuid[], timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_meetings(text, uuid, integer, uuid[], uuid[], timestamptz, timestamptz) TO manythreads_app, manythreads_system;

-- The definer function runs as the system role (so it reads the Personal notes row, and only to answer the word above).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meeting_privacy(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
