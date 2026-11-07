-- search 0006: a Personal file is not a search result (P20-02). Forward-only: never edit once applied.
--
-- A person's Personal files (files.owner_person_id set) are read through the Personal files screen only. The function stays SECURITY INVOKER, so
-- the row policy already hides them from everyone but their owner; this adds the rule that the owner's own files do not show up in the workspace
-- search either, and that an admin during a recorded open of someone's space does not find those files by searching. Same signature, same grants.

CREATE OR REPLACE FUNCTION app.search_files(
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
     WHERE f.owner_person_id IS NULL
       AND f.name %> v_query
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
     WHERE f.owner_person_id IS NULL
       AND (p_team_id IS NULL OR f.team_id = p_team_id)
       AND (p_from IS NULL OR f.uploader_id = ANY (p_from))
       AND (p_in IS NULL OR f.channel_id = ANY (p_in))
       AND (p_before IS NULL OR f.created_at < p_before)
       AND (p_after IS NULL OR f.created_at >= p_after)
     ORDER BY f.id DESC
     LIMIT v_limit;
  END IF;
END
$$;
