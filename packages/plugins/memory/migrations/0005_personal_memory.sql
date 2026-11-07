-- memory plugin 0005 (P20-05): a person's own Memory, kept as rows. Forward-only: never edit once applied.
--
-- A person's Memory is an OKF bundle (the open knowledge format the team's `memory/` folder uses) that belongs to ONE person and lives in two tables
-- here instead of a git repo: `memory_personal_files` (the current text of each file, with the frontmatter index beside it so lists and filters
-- never parse a body) and `memory_personal_versions` (every saved version, newest 50 per file, so an edit can be undone). The same shared check
-- (`validateOkfWrite`) is run by the plugin before a write, as for a team's repo.
--
-- WHO MAY READ: the owner; a workspace admin only during a live, audited "open" of that person's space (kernel 0016, read-only); the system role.
-- Nobody else, a team lead included. WHO MAY WRITE: nobody directly. Every write goes through `app.memory_personal_put` / `app.memory_personal_delete`
-- below, which decide with `app.actor()` who is asking:
--   * the owner (an active member who is not a guest), for their own bundle;
--   * a bot, only inside a live run whose asker is the owner AND whose bot the owner has allowed to read their Personal space right now
--     (`app.run_space_context()`, bots 0026) — a bot never names the owner, and a bot can never replace a file that a person wrote or verified;
--   * the system role (a job, such as the inbox filing a dropped note).
-- Inside the functions `app.is_system()` is TRUE (they run as the system role), so the real system role is told apart by `session_user`.
--
-- The bundle's own caps are the database's: at most 2000 files per person, 1,000,000 bytes per file, 50 saved versions per file.

CREATE TABLE app.memory_personal_files (
  owner_person_id uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  path            text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 300),
  content         text NOT NULL CHECK (octet_length(content) <= 1000000),
  version_no      integer NOT NULL DEFAULT 1 CHECK (version_no >= 1),
  size_bytes      integer NOT NULL CHECK (size_bytes >= 0),
  -- the frontmatter index (the shape of memory_concepts), filled by the plugin from the validated frontmatter
  type            text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 200),
  title           text NOT NULL DEFAULT '' CHECK (char_length(title) <= 500),
  description     text CHECK (description IS NULL OR char_length(description) <= 2000),
  tags            text[] NOT NULL DEFAULT '{}' CHECK (array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 100),
  status          text NOT NULL DEFAULT 'stable' CHECK (status IN ('draft', 'stable', 'deprecated')),
  stale_after     timestamptz,
  trust_tier      text NOT NULL DEFAULT 'unverified' CHECK (trust_tier IN ('unverified', 'machine-confirmed', 'human-reviewed')),
  origin          text NOT NULL DEFAULT '' CHECK (char_length(origin) <= 64),
  share_never     boolean NOT NULL DEFAULT false,
  generated_at    timestamptz,
  blob_sha        text NOT NULL CHECK (blob_sha ~ '^[0-9a-f]{40}$'),
  -- true when a person wrote or verified the current text: a bot then files a draft beside it instead of replacing it
  person_owned    boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_person_id, path)
);
CREATE INDEX memory_personal_files_workspace ON app.memory_personal_files (workspace_id);
CREATE INDEX memory_personal_files_tags ON app.memory_personal_files USING gin (tags);
COMMENT ON TABLE app.memory_personal_files IS 'rls: person — P: a person''s own Memory (OKF bundle) as rows, current text of each file with its frontmatter index; readable by the owner, by an admin during a live audited open of the space, and by the system; written only through app.memory_personal_put / _delete.';

CREATE TABLE app.memory_personal_versions (
  owner_person_id uuid NOT NULL,
  path            text NOT NULL,
  version_no      integer NOT NULL CHECK (version_no >= 1),
  content         text NOT NULL CHECK (octet_length(content) <= 1000000),
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes      integer NOT NULL CHECK (size_bytes >= 0),
  author_kind     text NOT NULL CHECK (author_kind IN ('person', 'bot', 'system')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_person_id, path, version_no),
  FOREIGN KEY (owner_person_id, path) REFERENCES app.memory_personal_files (owner_person_id, path) ON DELETE CASCADE
);
COMMENT ON TABLE app.memory_personal_versions IS 'rls: person — P: the saved versions of a person''s Memory files (newest 50 per file); same readers as memory_personal_files; written only by app.memory_personal_put.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memory_personal_files', 'memory_personal_versions'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON app.%I FOR SELECT USING (
        (SELECT app.is_system())
        OR owner_person_id = ANY ((SELECT app.readable_space_ids('read'))::uuid[]))$p$, t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()))', t || '_system', t);
    EXECUTE format('GRANT SELECT ON app.%I TO manythreads_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON app.%I TO manythreads_system', t);
  END LOOP;
END
$$;

-- app.memory_personal_caller: who is asking, and may they write this person's bundle ----------------------------------------
-- Returns 'system', 'person' or 'bot' when the caller may write `p_owner`'s bundle, else null. Never trusts an argument: the caller is app.actor().
CREATE FUNCTION app.memory_personal_caller(p_owner uuid) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws     uuid;
  v_actor  uuid := app.actor();
  v_kind   text;
  v_ref    uuid;
  v_role   text;
  v_ctx    record;
BEGIN
  SELECT p.workspace_id INTO v_ws FROM app.people p WHERE p.id = p_owner AND p.status = 'active';
  IF v_ws IS NULL THEN RETURN NULL; END IF;
  -- a guest has no Personal space
  SELECT wm.role INTO v_role FROM app.workspace_members wm WHERE wm.workspace_id = v_ws AND wm.person_id = p_owner;
  IF v_role IS NULL OR v_role = 'guest' THEN RETURN NULL; END IF;
  IF session_user = 'manythreads_system' THEN RETURN 'system'; END IF;
  IF app.workspace_id() IS DISTINCT FROM v_ws OR v_actor IS NULL THEN RETURN NULL; END IF;
  SELECT a.kind, a.ref_id INTO v_kind, v_ref FROM app.actors a WHERE a.id = v_actor AND a.workspace_id = v_ws;
  IF v_kind = 'person' AND v_ref = p_owner THEN RETURN 'person'; END IF;
  IF v_kind = 'bot' THEN
    SELECT c.personal_allowed, c.asker_person_id INTO v_ctx FROM app.run_space_context() c;
    IF FOUND AND v_ctx.personal_allowed AND v_ctx.asker_person_id = p_owner THEN RETURN 'bot'; END IF;
  END IF;
  RETURN NULL;
END
$$;

-- app.memory_personal_put: save a file (a new one, or the next version of one) --------------------------------------------
-- `p_meta` is the validated frontmatter index (type, title, description, tags, status, stale_after, trust_tier, origin, share_never, generated_at,
-- blob_sha, person_owned). `p_check_base`: when true the write is refused with 'conflict' unless the stored version is `p_base_version` (null: the file
-- must not exist yet). Answers a status, never an exception, so the plugin can word each one:
--   ok | unchanged | conflict | forbidden | person_owned (a bot may not replace a person's file) | too_many_files | too_large
CREATE FUNCTION app.memory_personal_put(p_owner uuid, p_path text, p_content text, p_meta jsonb, p_base_version integer, p_check_base boolean)
  RETURNS TABLE (status text, version_no integer, caller_kind text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_kind    text;
  v_cur     app.memory_personal_files%ROWTYPE;
  v_sha     text := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  v_size    integer := octet_length(p_content);
  v_ws      uuid;
  v_next    integer;
BEGIN
  v_kind := app.memory_personal_caller(p_owner);
  IF v_kind IS NULL THEN RETURN QUERY SELECT 'forbidden'::text, 0, NULL::text; RETURN; END IF;
  IF v_size > 1000000 THEN RETURN QUERY SELECT 'too_large'::text, 0, v_kind; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memory_personal:' || p_owner::text, 0));
  SELECT p.workspace_id INTO v_ws FROM app.people p WHERE p.id = p_owner;
  SELECT f.* INTO v_cur FROM app.memory_personal_files f WHERE f.owner_person_id = p_owner AND f.path = p_path FOR UPDATE;
  IF FOUND THEN
    IF v_kind = 'bot' AND v_cur.person_owned THEN RETURN QUERY SELECT 'person_owned'::text, v_cur.version_no, v_kind; RETURN; END IF;
    IF p_check_base AND p_base_version IS DISTINCT FROM v_cur.version_no THEN RETURN QUERY SELECT 'conflict'::text, v_cur.version_no, v_kind; RETURN; END IF;
    IF v_sha = encode(sha256(convert_to(v_cur.content, 'UTF8')), 'hex') THEN RETURN QUERY SELECT 'unchanged'::text, v_cur.version_no, v_kind; RETURN; END IF;
    v_next := v_cur.version_no + 1;
    UPDATE app.memory_personal_files SET
      content = p_content, version_no = v_next, size_bytes = v_size,
      type = p_meta->>'type', title = coalesce(p_meta->>'title', ''), description = p_meta->>'description',
      tags = coalesce(ARRAY(SELECT jsonb_array_elements_text(p_meta->'tags')), '{}'),
      status = coalesce(p_meta->>'status', 'stable'), stale_after = (p_meta->>'stale_after')::timestamptz,
      trust_tier = coalesce(p_meta->>'trust_tier', 'unverified'), origin = coalesce(p_meta->>'origin', ''),
      share_never = coalesce((p_meta->>'share_never')::boolean, false), generated_at = (p_meta->>'generated_at')::timestamptz,
      blob_sha = p_meta->>'blob_sha',
      person_owned = (v_kind = 'person') OR coalesce((p_meta->>'person_owned')::boolean, false),
      updated_at = now()
     WHERE owner_person_id = p_owner AND path = p_path;
  ELSE
    IF p_check_base AND p_base_version IS NOT NULL THEN RETURN QUERY SELECT 'conflict'::text, 0, v_kind; RETURN; END IF;
    IF (SELECT count(*) FROM app.memory_personal_files WHERE owner_person_id = p_owner) >= 2000 THEN
      RETURN QUERY SELECT 'too_many_files'::text, 0, v_kind; RETURN;
    END IF;
    v_next := 1;
    INSERT INTO app.memory_personal_files
      (owner_person_id, workspace_id, path, content, version_no, size_bytes, type, title, description, tags, status, stale_after, trust_tier, origin,
       share_never, generated_at, blob_sha, person_owned)
    VALUES
      (p_owner, v_ws, p_path, p_content, 1, v_size, p_meta->>'type', coalesce(p_meta->>'title', ''), p_meta->>'description',
       coalesce(ARRAY(SELECT jsonb_array_elements_text(p_meta->'tags')), '{}'),
       coalesce(p_meta->>'status', 'stable'), (p_meta->>'stale_after')::timestamptz,
       coalesce(p_meta->>'trust_tier', 'unverified'), coalesce(p_meta->>'origin', ''),
       coalesce((p_meta->>'share_never')::boolean, false), (p_meta->>'generated_at')::timestamptz, p_meta->>'blob_sha',
       (v_kind = 'person') OR coalesce((p_meta->>'person_owned')::boolean, false));
  END IF;
  INSERT INTO app.memory_personal_versions (owner_person_id, path, version_no, content, sha256, size_bytes, author_kind)
  VALUES (p_owner, p_path, v_next, p_content, v_sha, v_size, v_kind);
  DELETE FROM app.memory_personal_versions v WHERE v.owner_person_id = p_owner AND v.path = p_path AND v.version_no <= v_next - 50;
  RETURN QUERY SELECT 'ok'::text, v_next, v_kind;
END
$$;

-- app.memory_personal_delete: remove a file with its saved versions. Only the owner or the system; a bot never deletes. --------------------
CREATE FUNCTION app.memory_personal_delete(p_owner uuid, p_path text)
  RETURNS TABLE (status text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_kind text := app.memory_personal_caller(p_owner);
BEGIN
  IF v_kind IS NULL OR v_kind = 'bot' THEN RETURN QUERY SELECT 'forbidden'::text; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memory_personal:' || p_owner::text, 0));
  DELETE FROM app.memory_personal_files WHERE owner_person_id = p_owner AND path = p_path;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::text;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.memory_personal_caller(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.memory_personal_put(uuid, text, text, jsonb, integer, boolean) OWNER TO manythreads_system;
ALTER FUNCTION app.memory_personal_delete(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.memory_personal_caller(uuid), app.memory_personal_put(uuid, text, text, jsonb, integer, boolean), app.memory_personal_delete(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_personal_put(uuid, text, text, jsonb, integer, boolean), app.memory_personal_delete(uuid, text) TO manythreads_app, manythreads_system;
-- memory_personal_caller is called only by the two doors (which run as the system role): the app role cannot ask it.
GRANT EXECUTE ON FUNCTION app.memory_personal_caller(uuid) TO manythreads_system;
COMMENT ON FUNCTION app.memory_personal_put(uuid, text, text, jsonb, integer, boolean) IS
  'The only way to save a file of a person''s Memory: authorises the caller (the owner, the owner''s asked-and-allowed bot, or the system), checks the base version, keeps 50 versions and answers a status, never an exception.';
