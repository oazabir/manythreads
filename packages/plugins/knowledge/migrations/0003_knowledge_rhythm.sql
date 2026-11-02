-- knowledge 0003: a rhythm per source, web-page sources, the base's stored state, and the questions a base could not answer (PLAN P8-07, P8-08, P8-33).
-- Forward-only: never edit once applied.
--
--  * knowledge_sources.sync_minutes   how often the source is read again (NULL: only when someone presses Re-sync). The job `knowledge.sync` reads
--                                     the sources that are due; an unchanged file costs one comparison of a hash.
--  * knowledge_sources.kind 'url'     one public web page or file the platform fetches (the address, vetted again at every read, is on the row). Many
--                                     per base, each with the one document it makes. Drive, SharePoint and Notion wait for the phase-8 connections.
--  * knowledge_bases.status           the base's state as a person reads it: 'empty' (no documents), 'ready' (all searchable), 'attention' (a
--                                     document or a source failed). Kept by triggers, so every writer (a route, the sync job) moves it the same way.
--  * knowledge_gaps                   a question a bot that answers only from its bases could not answer; the job `knowledge.gaps` posts each, once,
--                                     to the team's #kb-updates channel.

ALTER TABLE app.knowledge_sources
  ADD COLUMN sync_minutes integer CHECK (sync_minutes IS NULL OR sync_minutes BETWEEN 15 AND 10080),
  ADD COLUMN url          text    CHECK (url IS NULL OR char_length(url) BETWEEN 8 AND 2048),
  ADD COLUMN label        text    CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 120);
ALTER TABLE app.knowledge_sources DROP CONSTRAINT knowledge_sources_kind_check;
ALTER TABLE app.knowledge_sources ADD CONSTRAINT knowledge_sources_kind_check CHECK (kind IN ('upload', 'repo', 'url'));
ALTER TABLE app.knowledge_sources ADD CONSTRAINT knowledge_sources_url_shape CHECK ((kind = 'url') = (url IS NOT NULL));
ALTER TABLE app.knowledge_sources DROP CONSTRAINT knowledge_sources_base_id_kind_key;
CREATE UNIQUE INDEX knowledge_sources_one_of_kind ON app.knowledge_sources (base_id, kind) WHERE kind <> 'url';
CREATE UNIQUE INDEX knowledge_sources_url ON app.knowledge_sources (base_id, url) WHERE kind = 'url';
CREATE INDEX knowledge_sources_due ON app.knowledge_sources (last_synced_at NULLS FIRST) WHERE sync_minutes IS NOT NULL;

-- At most 20 web-page sources per base; a lock per base makes inserts take turns (the count runs under the caller's own read policy).
CREATE FUNCTION app.knowledge_sources_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.kind = 'url' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('knowledge_sources:' || NEW.base_id::text, 0));
    IF (SELECT count(*) FROM app.knowledge_sources WHERE base_id = NEW.base_id AND kind = 'url') >= 20 THEN
      RAISE EXCEPTION 'A knowledge base can have at most 20 web-page sources.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.knowledge_sources_cap() FROM PUBLIC;
CREATE TRIGGER knowledge_sources_cap BEFORE INSERT ON app.knowledge_sources FOR EACH ROW EXECUTE FUNCTION app.knowledge_sources_cap();

-- The base's state, stored. Recomputed by a definer function owned by the system role (it writes the base's own row whoever wrote the document or
-- source that changed it; the writer was already allowed to write that row's child, and the function takes only the base id from it).
ALTER TABLE app.knowledge_bases ADD COLUMN status text NOT NULL DEFAULT 'empty' CHECK (status IN ('empty', 'ready', 'attention'));

CREATE FUNCTION app.knowledge_base_refresh_status(p_base uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.knowledge_bases b SET status = CASE
      WHEN EXISTS (SELECT 1 FROM app.knowledge_documents d WHERE d.base_id = b.id AND d.status = 'failed')
        OR EXISTS (SELECT 1 FROM app.knowledge_sources s WHERE s.base_id = b.id AND s.error IS NOT NULL) THEN 'attention'
      WHEN NOT EXISTS (SELECT 1 FROM app.knowledge_documents d WHERE d.base_id = b.id) THEN 'empty'
      ELSE 'ready' END
   WHERE b.id = p_base;
END
$$;

CREATE FUNCTION app.knowledge_base_status_trigger() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app.knowledge_base_refresh_status(OLD.base_id);
  ELSE
    PERFORM app.knowledge_base_refresh_status(NEW.base_id);
  END IF;
  RETURN NULL;
END
$$;

-- Owned by the system role like every other definer function.
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.knowledge_base_refresh_status(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.knowledge_base_status_trigger() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.knowledge_base_refresh_status(uuid), app.knowledge_base_status_trigger() FROM PUBLIC;

CREATE TRIGGER knowledge_documents_status AFTER INSERT OR DELETE OR UPDATE OF status ON app.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION app.knowledge_base_status_trigger();
CREATE TRIGGER knowledge_sources_status AFTER INSERT OR DELETE OR UPDATE OF error ON app.knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION app.knowledge_base_status_trigger();

-- bases that exist already
UPDATE app.knowledge_bases b SET status = CASE
    WHEN EXISTS (SELECT 1 FROM app.knowledge_documents d WHERE d.base_id = b.id AND d.status = 'failed')
      OR EXISTS (SELECT 1 FROM app.knowledge_sources s WHERE s.base_id = b.id AND s.error IS NOT NULL) THEN 'attention'
    WHEN NOT EXISTS (SELECT 1 FROM app.knowledge_documents d WHERE d.base_id = b.id) THEN 'empty'
    ELSE 'ready' END;

-- The questions a base could not answer. Written by the search tool as the person who asked (any reader of the team), read by the people who manage
-- the team (they fill the gap) and the system, which posts them. One row per team, question and day, so the same question asked ten times is one line.
CREATE TABLE app.knowledge_gaps (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid        NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  bot_id       uuid,  -- the bot that asked; no foreign key (a bot is rebuilt from its BOT.md and may be gone by the time the note is written: the note then says nobody wrote it)
  query        text        NOT NULL CHECK (char_length(query) BETWEEN 2 AND 200),
  day          date        NOT NULL DEFAULT current_date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  posted_at    timestamptz,
  outcome      text        CHECK (outcome IN ('posted', 'no_channel', 'no_author')),
  CHECK ((posted_at IS NULL) = (outcome IS NULL))
);
CREATE UNIQUE INDEX knowledge_gaps_once ON app.knowledge_gaps (team_id, lower(query), day);
CREATE INDEX knowledge_gaps_open ON app.knowledge_gaps (created_at) WHERE posted_at IS NULL;
CREATE INDEX knowledge_gaps_workspace ON app.knowledge_gaps (workspace_id);
COMMENT ON TABLE app.knowledge_gaps IS 'rls: team — T: readable by the people who manage the team and the system; a reader of the team may add one (the search tool does, as the asker); only the system changes or deletes one.';

ALTER TABLE app.knowledge_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.knowledge_gaps FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_gaps_select ON app.knowledge_gaps FOR SELECT USING ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]));
CREATE POLICY knowledge_gaps_insert ON app.knowledge_gaps FOR INSERT WITH CHECK ((SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
CREATE POLICY knowledge_gaps_update ON app.knowledge_gaps FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY knowledge_gaps_delete ON app.knowledge_gaps FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.knowledge_gaps TO manythreads_app;

-- A team that nobody answers cannot grow this table without bound: past 100 open lines new ones are dropped (the open ones are still posted).
CREATE FUNCTION app.knowledge_gaps_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF (SELECT count(*) FROM app.knowledge_gaps WHERE team_id = NEW.team_id AND posted_at IS NULL) >= 100 THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.knowledge_gaps_cap() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.knowledge_gaps_cap() FROM PUBLIC;
CREATE TRIGGER knowledge_gaps_cap BEFORE INSERT ON app.knowledge_gaps FOR EACH ROW EXECUTE FUNCTION app.knowledge_gaps_cap();

-- The note in #kb-updates is written by the bot that could not answer (the platform's own system actor is no row of `actors`, so it cannot be an author).
-- This sets the transaction's actor to that bot's actor, for the system role only and only inside the transaction's own workspace; it grants nothing else.
CREATE FUNCTION app.knowledge_act_as_bot(p_bot_id uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the system role acts as a bot here' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT a.id INTO v_actor FROM app.actors a
   WHERE a.kind = 'bot' AND a.ref_id = p_bot_id AND a.workspace_id = app.workspace_id();
  IF v_actor IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.actor_id', v_actor::text, true);
  RETURN v_actor;
END
$$;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.knowledge_act_as_bot(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.knowledge_act_as_bot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.knowledge_act_as_bot(uuid) TO manythreads_system;
