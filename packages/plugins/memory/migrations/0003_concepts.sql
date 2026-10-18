-- memory plugin 0003: the frontmatter index of a team's OKF bundle (PLAN A.5, P5-25; SPEC §12.1, §5.1). Forward-only: never edit once applied.
--
--  * memory_concepts: one row per concept of the team's memory bundle (`memory/**.md` except the platform's own `index.md` and `log.md`), holding
--    the validated frontmatter and nothing else — never the body. Git is the truth; this is rebuilt from `repo.committed` by the memory plugin's
--    own subscriber (never written by a request), so the Memory screen, Brain's filters and (phase 8) share selection can query the bundle without
--    reading git. A concept the writer refused, or one that was deleted or stops being text, has no row.
--  * The vocabulary of `status`, `trust_tier` and the derived fields is the shared one (`@manythreads/shared` `OkfStatus`, `OkfTrustTier`, the
--    `MemoryConceptSummary` shape), so the table, the entity and the writer cannot drift. `trust_tier` is spelled with hyphens
--    (`unverified`, `machine-confirmed`, `human-reviewed`), the shared `OkfTrustTier` spelling, not the underscore shorthand of PLAN A.5's prose:
--    one vocabulary is what stops the drift A.5 warns about.
--  * `origin` mirrors the free extension key `origin` (`drop`, `share`, `journal`, `person`, …); the values are a convention, not a closed set,
--    so there is no CHECK on it. `share_never` is the `share: never` flag the share selection excludes on (phase 8). `from_team` is the team a
--    received digest came from (the extension key `from`), when it names one.
--  * `stale_after` and `generated_at` are timestamptz: the frontmatter's date is normalised to an instant when the row is written (a bare
--    `YYYY-MM-DD` becomes midnight UTC); an unreadable date leaves the column null, which every reader treats as "no stale_after" / "no generated".
--
-- Ordering: the manifest's `dependsOn` puts this after repo-git (the fill reads `app.repo_entries`); the tables it references are resolved then.

CREATE TABLE app.memory_concepts (
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  path         text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 500),
  type         text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 200),
  title        text NOT NULL DEFAULT '' CHECK (char_length(title) <= 500),
  description  text CHECK (description IS NULL OR char_length(description) <= 2000),
  tags         text[] NOT NULL DEFAULT '{}' CHECK (array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 100),
  status       text NOT NULL DEFAULT 'stable' CHECK (status IN ('draft', 'stable', 'deprecated')),
  stale_after  timestamptz,
  trust_tier   text NOT NULL DEFAULT 'unverified' CHECK (trust_tier IN ('unverified', 'machine-confirmed', 'human-reviewed')),
  origin       text NOT NULL DEFAULT '' CHECK (char_length(origin) <= 64),
  share_never  boolean NOT NULL DEFAULT false,
  from_team    uuid REFERENCES app.teams (id) ON DELETE SET NULL,
  blob_sha     text NOT NULL CHECK (blob_sha ~ '^[0-9a-f]{40}$'),
  generated_at timestamptz,
  PRIMARY KEY (team_id, path)
);
-- "which concepts of the team carry this tag" (the recall filter)
CREATE INDEX memory_concepts_tags ON app.memory_concepts USING gin (tags);
-- "the team's concepts of one type" (the tree and the recall filter)
CREATE INDEX memory_concepts_team_type ON app.memory_concepts (team_id, type);
-- "the team's concepts that can go stale" (a stale-only view never scans the rest)
CREATE INDEX memory_concepts_team_stale ON app.memory_concepts (team_id, stale_after) WHERE stale_after IS NOT NULL;
-- search a concept by its title (the Files/Memory filter), never a sequential scan
CREATE INDEX memory_concepts_title_trgm ON app.memory_concepts USING gin (title gin_trgm_ops);
COMMENT ON TABLE app.memory_concepts IS 'rls: team — T: the frontmatter index of a team''s OKF memory bundle (one row per concept, never the body), rebuilt from repo.committed; git is the truth; readable by whoever reads the team, written by the system role only.';

-- Row level security ----------------------------------------------------------------------------------------------------
ALTER TABLE app.memory_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_concepts FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_concepts_select ON app.memory_concepts FOR SELECT USING (
  (SELECT app.is_system())
  OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY memory_concepts_system ON app.memory_concepts FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.memory_concepts TO manythreads_app;
