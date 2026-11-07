-- knowledge 0004 (P20-06): a person's own knowledge bases. Forward-only: never edit once applied.
--
-- A base now belongs to exactly one space: a team (as before) or one person (their Personal space, kernel 0016). Each of the four tables carries
-- `team_id` OR `owner_person_id`, never both, never neither; the passages (`knowledge_chunks`) carry the owner themselves so the read policy needs no join.
-- A person's base keeps its original in blob storage like a team's, but has no copy in a team repo (`repo_path` stays null), no repo source and no
-- reading rhythm of its own yet; its documents are searched by the person and by the bots they allow (bots 0026, the gateway's space list).
--
-- THE ACCESS RULE is the space template of kernel 0016: read = the person's own id, a team the caller reads, or a person whose space an admin holds a live
-- audited open on; write = the owner alone (never a guest), or the team's managers as before. An admin's open is read-only: no write policy names it.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_bases', 'knowledge_sources', 'knowledge_documents', 'knowledge_chunks'] LOOP
    EXECUTE format('ALTER TABLE app.%I ALTER COLUMN team_id DROP NOT NULL', t);
    EXECUTE format('ALTER TABLE app.%I ADD COLUMN owner_person_id uuid REFERENCES app.people (id) ON DELETE CASCADE', t);
    EXECUTE format('ALTER TABLE app.%I ADD CONSTRAINT %I CHECK (num_nonnulls(team_id, owner_person_id) = 1)', t, t || '_one_space');
    EXECUTE format('CREATE INDEX %I ON app.%I (owner_person_id) WHERE owner_person_id IS NOT NULL', t || '_owner', t);
  END LOOP;
END
$$;

-- A person's slug is unique among their own bases, as a team's is among the team's.
CREATE UNIQUE INDEX knowledge_bases_owner_slug ON app.knowledge_bases (owner_person_id, slug) WHERE owner_person_id IS NOT NULL;
ALTER TABLE app.knowledge_bases ADD CONSTRAINT knowledge_bases_id_owner UNIQUE (id, owner_person_id);
-- A child's owner agrees with its parent's (the team-side composite keys already do this for a team's rows; a null team skips them).
ALTER TABLE app.knowledge_sources ADD FOREIGN KEY (base_id, owner_person_id) REFERENCES app.knowledge_bases (id, owner_person_id) ON DELETE CASCADE;
ALTER TABLE app.knowledge_documents ADD FOREIGN KEY (base_id, owner_person_id) REFERENCES app.knowledge_bases (id, owner_person_id) ON DELETE CASCADE;
ALTER TABLE app.knowledge_chunks ADD FOREIGN KEY (base_id, owner_person_id) REFERENCES app.knowledge_bases (id, owner_person_id) ON DELETE CASCADE;

-- A Personal base has no repo source, and no row of a Personal base may name a repo path.
ALTER TABLE app.knowledge_sources ADD CONSTRAINT knowledge_sources_personal_kind CHECK (owner_person_id IS NULL OR kind IN ('upload', 'url'));
ALTER TABLE app.knowledge_documents ADD CONSTRAINT knowledge_documents_personal_no_repo CHECK (owner_person_id IS NULL OR (repo_path IS NULL AND repo_sha IS NULL));

-- Policies: the space template. Reads hoist both sets once per statement; a write is the owner (an active non-guest member) or a team manager.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_bases', 'knowledge_sources', 'knowledge_documents', 'knowledge_chunks'] LOOP
    EXECUTE format('DROP POLICY %I ON app.%I', t || '_select', t);
    EXECUTE format('DROP POLICY %I ON app.%I', t || '_insert', t);
    EXECUTE format('DROP POLICY %I ON app.%I', t || '_update', t);
    EXECUTE format('DROP POLICY %I ON app.%I', t || '_delete', t);
    EXECUTE format($p$CREATE POLICY %I ON app.%I FOR SELECT USING (
        (SELECT app.is_system())
        OR owner_person_id = ANY ((SELECT app.readable_space_ids('read'))::uuid[])
        OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]))$p$, t || '_select', t);
    EXECUTE format($p$CREATE POLICY %I ON app.%I FOR INSERT WITH CHECK (
        (SELECT app.is_system())
        OR (owner_person_id = (SELECT app.person_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin', 'member'))
        OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))$p$, t || '_insert', t);
    EXECUTE format($p$CREATE POLICY %I ON app.%I FOR UPDATE USING (
        (SELECT app.is_system())
        OR (owner_person_id = (SELECT app.person_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin', 'member'))
        OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
      WITH CHECK (
        (SELECT app.is_system())
        OR (owner_person_id = (SELECT app.person_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin', 'member'))
        OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))$p$, t || '_update', t);
    EXECUTE format($p$CREATE POLICY %I ON app.%I FOR DELETE USING (
        (SELECT app.is_system())
        OR (owner_person_id = (SELECT app.person_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin', 'member'))
        OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))$p$, t || '_delete', t);
  END LOOP;
END
$$;

COMMENT ON TABLE app.knowledge_bases IS 'rls: team — T for a team''s base: readable by the people of the team (app.readable_team_ids read; not a guest), written by team leads and workspace admins (manage) and the system. P for a person''s base (owner_person_id): its owner reads and writes it (never a guest), and an admin reads it during a live audited open of that space.';
COMMENT ON TABLE app.knowledge_sources IS 'rls: team — T: as knowledge_bases; P for a source of a person''s base (an upload or a web address, never the repo).';
COMMENT ON TABLE app.knowledge_documents IS 'rls: team — T: as knowledge_bases; P for a document of a person''s base (no repo copy). `blob_key` points at the original in blob storage (the files blob GC reads it).';
COMMENT ON TABLE app.knowledge_chunks IS 'rls: team — T: as knowledge_bases; P for a passage of a person''s base (owner_person_id on the passage, no join). Older versions of a document''s passages are kept for citations.';

-- The caps are the database's: a person may have at most 10 bases (a team 20). One lock per owner makes inserts take turns.
CREATE OR REPLACE FUNCTION app.knowledge_bases_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.owner_person_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('knowledge_bases:' || NEW.owner_person_id::text, 0));
    IF (SELECT count(*) FROM app.knowledge_bases WHERE owner_person_id = NEW.owner_person_id) >= 10 THEN
      RAISE EXCEPTION 'You can have at most 10 knowledge bases of your own.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge_bases:' || NEW.team_id::text, 0));
  IF (SELECT count(*) FROM app.knowledge_bases WHERE team_id = NEW.team_id) >= 20 THEN
    RAISE EXCEPTION 'A team can have at most 20 knowledge bases.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
