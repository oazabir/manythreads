-- repo-git 0001: the index of each team's git repository (PLAN.md A.4, P4-04; SPEC section 5.1). Forward-only.
--
-- Git is the truth: the bare repository at ${MANYTHREADS_REPO_DIR}/<team id>.git holds every file and every commit. These three tables mirror
-- it for what git is bad at: searching file names and page text (trigram), listing a team's files, and the History panel (commits by
-- author, time, path). The writer (one per team, under pg_advisory_xact_lock) updates them in the same transaction that emits
-- `repo.repo.committed`; when git got ahead (a crash between the commit and the transaction) the next write rebuilds the index from git.
--
-- Every table is readable by the people who can read the team (hoisted readable_team_ids, kernel 0011) and written only by the system
-- role. A request reaches the writing side through the SECURITY DEFINER functions at the end, which check the caller (a member who may
-- post, or the system) with app.lookup_can_team: inside a definer function owned by manythreads_system, app.is_system() is TRUE.

-- repos (T): one per team ----------------------------------------------------------------------------------------------------------
CREATE TABLE app.repos (
  team_id    uuid PRIMARY KEY REFERENCES app.teams (id) ON DELETE CASCADE,
  path       text NOT NULL CHECK (path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.git$'),  -- relative to MANYTHREADS_REPO_DIR
  head_sha   text CHECK (head_sha ~ '^[0-9a-f]{40}$'),                                                                  -- null until the first commit
  remote     jsonb,                                                                                                      -- push target (later); never a credential
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.repos IS 'rls: team — T: the repository of a team; readable by whoever reads the team, written by the system role only (through app.repo_register / app.repo_index_apply).';

-- repo_entries (T): the files of the current tree ------------------------------------------------------------------------------------
CREATE TABLE app.repo_entries (
  team_id         uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  path            text NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  kind            text NOT NULL DEFAULT 'file' CHECK (kind IN ('file')),
  blob_sha        text NOT NULL CHECK (blob_sha ~ '^[0-9a-f]{40}$'),
  size            bigint NOT NULL CHECK (size >= 0),
  last_commit_sha text NOT NULL CHECK (last_commit_sha ~ '^[0-9a-f]{40}$'),
  -- the text of a UTF-8 file up to 1 MB (page and file search); bounded by constraint because pg_trgm operators are marked LEAKPROOF (search 0001)
  text_plain      text CHECK (text_plain IS NULL OR length(text_plain) <= 1048576),
  PRIMARY KEY (team_id, path)
);
CREATE INDEX repo_entries_path_trgm ON app.repo_entries USING gin (path gin_trgm_ops);
CREATE INDEX repo_entries_text_trgm ON app.repo_entries USING gin (text_plain gin_trgm_ops);
COMMENT ON TABLE app.repo_entries IS 'rls: team — T: an index of the current tree of a team repository (path, blob, size, text for search); readable by whoever reads the team.';

-- repo_commits (T): the History index ------------------------------------------------------------------------------------------------
-- author_id and co_authors are actor ids without a foreign key: history outlives an actor, and the git author line carries the id too.
CREATE TABLE app.repo_commits (
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  sha          text NOT NULL CHECK (sha ~ '^[0-9a-f]{40}$'),
  parent_sha   text CHECK (parent_sha ~ '^[0-9a-f]{40}$'),
  author_id    uuid,                                  -- null: a commit the system made (a team's first commit)
  co_authors   uuid[] NOT NULL DEFAULT '{}',
  message      text NOT NULL,
  committed_at timestamptz NOT NULL,
  paths        text[] NOT NULL DEFAULT '{}',
  -- git dates have one-second resolution; the order the index learned of commits breaks ties (newest first)
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (team_id, sha)
);
CREATE INDEX repo_commits_team_time ON app.repo_commits (team_id, committed_at DESC, seq DESC);
CREATE INDEX repo_commits_committed_brin ON app.repo_commits USING brin (committed_at);
CREATE INDEX repo_commits_paths ON app.repo_commits USING gin (paths);
CREATE INDEX repo_commits_author ON app.repo_commits (author_id) WHERE author_id IS NOT NULL;
COMMENT ON TABLE app.repo_commits IS 'rls: team — T: the History index of a team repository (author, co-authors, message, paths); readable by whoever reads the team.';

-- Row level security ------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.repos FORCE ROW LEVEL SECURITY;
ALTER TABLE app.repo_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.repo_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE app.repo_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.repo_commits FORCE ROW LEVEL SECURITY;

CREATE POLICY repos_select ON app.repos FOR SELECT
  USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY repos_system ON app.repos FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

CREATE POLICY repo_entries_select ON app.repo_entries FOR SELECT
  USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY repo_entries_system ON app.repo_entries FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

CREATE POLICY repo_commits_select ON app.repo_commits FOR SELECT
  USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY repo_commits_system ON app.repo_commits FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

GRANT SELECT ON app.repos, app.repo_entries, app.repo_commits TO manythreads_app;

-- The writing side: narrow SECURITY DEFINER functions (CLAUDE.md: non-system code reaches system tables through one) ----------------
-- Who may call: the system role (jobs, event handlers; session_user, because inside a definer function current_user is the owner) or a
-- team member who may post (a lead, a member, a bot on the roster, a workspace admin). A guest and an outsider get 42501.

-- Get-or-create the repos row of a team.
CREATE FUNCTION app.repo_register(p_team_id uuid, p_path text) RETURNS app.repos
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  r app.repos;
BEGIN
  IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_can_team(p_team_id, 'post'), false) THEN
    RAISE EXCEPTION 'you may not open the repository of this team' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.repos (team_id, path) VALUES (p_team_id, p_path)
  ON CONFLICT (team_id) DO SELECT
  RETURNING * INTO r;
  RETURN r;
END
$$;

-- What the first commit needs: the team's name and slug, the TEAM.md held by team creation (team_pending_files), the template's own copy.
CREATE FUNCTION app.repo_seed(p_team_id uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_can_team(p_team_id, 'post'), false) THEN
    RAISE EXCEPTION 'you may not open the repository of this team' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'name', t.name,
      'slug', t.slug,
      'templateTeamMd', t.template_definition ->> 'teamMd',
      'pending', CASE WHEN p.applied_at IS NULL THEN p.files ELSE NULL END,
      'workspaceId', t.workspace_id)
    FROM app.teams t LEFT JOIN app.team_pending_files p ON p.team_id = t.id
    WHERE t.id = p_team_id);
END
$$;

-- Records one or more commits: the commit rows, the changed files, the new head. `p_expected_head` is the head the index had when the writer
-- looked (under the team lock); a different value means another writer got in between and raises 55000. `p_replace_all` rebuilds the file
-- index from `p_upserts` (the catch-up after git got ahead). `p_stamp_pending` marks the team's pending files as applied (the first commit).
CREATE FUNCTION app.repo_index_apply(
  p_team_id        uuid,
  p_expected_head  text,
  p_new_head       text,
  p_commits        jsonb,
  p_upserts        jsonb,
  p_deletes        text[],
  p_replace_all    boolean,
  p_stamp_pending  boolean
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_head text;
BEGIN
  IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_can_team(p_team_id, 'post'), false) THEN
    RAISE EXCEPTION 'you may not write to the repository of this team' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r.head_sha INTO v_head FROM app.repos r WHERE r.team_id = p_team_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the team has no repository row' USING ERRCODE = 'P0002';
  END IF;
  IF NOT p_replace_all AND v_head IS DISTINCT FROM p_expected_head THEN
    RAISE EXCEPTION 'the repository index is at % but the commit builds on %', coalesce(v_head, 'nothing'), coalesce(p_expected_head, 'nothing')
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.repo_commits (team_id, sha, parent_sha, author_id, co_authors, message, committed_at, paths)
  SELECT p_team_id, c.sha, c.parent_sha, c.author_id,
         coalesce((SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(c.co_authors) AS x), '{}'::uuid[]),
         c.message, c.committed_at,
         coalesce((SELECT array_agg(x) FROM jsonb_array_elements_text(c.paths) AS x), '{}'::text[])
  FROM jsonb_to_recordset(coalesce(p_commits, '[]'::jsonb))
       AS c(sha text, parent_sha text, author_id uuid, co_authors jsonb, message text, committed_at timestamptz, paths jsonb)
  ON CONFLICT (team_id, sha) DO NOTHING;

  IF p_replace_all THEN
    DELETE FROM app.repo_entries WHERE team_id = p_team_id;
  ELSIF coalesce(array_length(p_deletes, 1), 0) > 0 THEN
    DELETE FROM app.repo_entries WHERE team_id = p_team_id AND path = ANY (p_deletes);
  END IF;

  INSERT INTO app.repo_entries (team_id, path, kind, blob_sha, size, last_commit_sha, text_plain)
  SELECT p_team_id, u.path, 'file', u.blob_sha, u.size, u.last_commit_sha, u.text_plain
  FROM jsonb_to_recordset(coalesce(p_upserts, '[]'::jsonb)) AS u(path text, blob_sha text, size bigint, last_commit_sha text, text_plain text)
  ON CONFLICT (team_id, path) DO UPDATE
    SET blob_sha = EXCLUDED.blob_sha, size = EXCLUDED.size, last_commit_sha = EXCLUDED.last_commit_sha, text_plain = EXCLUDED.text_plain;

  UPDATE app.repos SET head_sha = p_new_head, updated_at = now() WHERE team_id = p_team_id;

  IF p_stamp_pending THEN
    UPDATE app.team_pending_files SET applied_at = now() WHERE team_id = p_team_id AND applied_at IS NULL;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION app.repo_register(uuid, text), app.repo_seed(uuid), app.repo_index_apply(uuid, text, text, jsonb, jsonb, text[], boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.repo_register(uuid, text), app.repo_seed(uuid), app.repo_index_apply(uuid, text, text, jsonb, jsonb, text[], boolean, boolean)
  TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.repo_register(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.repo_seed(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.repo_index_apply(uuid, text, text, jsonb, jsonb, text[], boolean, boolean) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

-- Backfill: a repository for every team that exists now (one idempotent job per team; the worker creates the bare repo and the first commit).
-- Needs a role that passes the jobs policy (the owner is a superuser here and on CNPG, MISTAKES P1-13); if it is not, the first request
-- for a team's repo creates it the same way, so skipping is safe.
DO $$
BEGIN
  INSERT INTO app.jobs (queue, payload, dedupe_key)
  SELECT 'repo-git.init', jsonb_build_object('workspaceId', t.workspace_id, 'teamId', t.id), 'repo-git.init:' || t.id
  FROM app.teams t
  ON CONFLICT (queue, dedupe_key) WHERE state IN ('ready', 'running') DO NOTHING;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'repo-git: could not enqueue the repository backfill (%); repositories are created on first use', SQLERRM;
END
$$;
