-- import 0001: bring a Slack or Mattermost export in (PLAN P14-13). Forward-only: never edit once applied.
--
-- Three tables:
--
--   import_runs    one row per uploaded archive: where it is (uploaded, analysing, analysed, queued, running, done, failed, cancelled), the dry-run report, the
--                  progress and the final report. Workspace owners and admins read and manage them; the background job (the system role) updates progress.
--   import_people  a placeholder for each person of an archive who has no account here: a name, the email the archive gave and the actor that signs their messages.
--                  When someone signs in with a verified copy of that email the placeholder is claimed (below) and the messages become theirs.
--   import_map     which row here each id of the archive became (channel, message, direct conversation). It makes a second run of the same archive write nothing
--                  twice. Only the background job touches it; no request can read it.
--
-- A placeholder is an actor of kind `system` whose ref_id is the import_people row. It is not a person: it cannot sign in, appears in no member list,
-- and holds no seat. (A suspended person would have blocked the real person's invitation and sign-in.)

CREATE TABLE app.import_runs (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('slack', 'mattermost')),
  team_id          uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'analysing', 'analysed', 'queued', 'running', 'done', 'failed', 'cancelled')),
  file_name        text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  size_bytes       bigint NOT NULL CHECK (size_bytes >= 0),
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  blob_key         text CHECK (blob_key IS NULL OR char_length(blob_key) BETWEEN 1 AND 300),
  created_by       uuid NOT NULL REFERENCES app.actors (id),
  started_by       uuid REFERENCES app.actors (id),
  dry_run_report   jsonb,
  report           jsonb,
  progress         jsonb,
  error            text CHECK (error IS NULL OR char_length(error) <= 500),
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX import_runs_workspace ON app.import_runs (workspace_id, id DESC);
CREATE INDEX import_runs_team ON app.import_runs (team_id);
CREATE INDEX import_runs_created_by ON app.import_runs (created_by);
CREATE INDEX import_runs_started_by ON app.import_runs (started_by) WHERE started_by IS NOT NULL;
COMMENT ON TABLE app.import_runs IS 'rls: workspace — W: one uploaded export archive and its dry-run and final reports; readable and managed by workspace owners and admins, progress written by the import job.';

CREATE TABLE app.import_people (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  source        text NOT NULL CHECK (source IN ('slack', 'mattermost')),
  source_id     text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 200),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  email         text CHECK (email IS NULL OR (email = lower(email) AND char_length(email) BETWEEN 3 AND 320)),
  actor_id      uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  claimed_by    uuid REFERENCES app.people (id) ON DELETE SET NULL,
  claimed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source, source_id),
  UNIQUE (actor_id)
);
CREATE INDEX import_people_email ON app.import_people (workspace_id, email) WHERE claimed_at IS NULL AND email IS NOT NULL;
CREATE INDEX import_people_claimed_by ON app.import_people (claimed_by) WHERE claimed_by IS NOT NULL;
COMMENT ON TABLE app.import_people IS 'rls: workspace — W: a stand-in for a person of an imported archive who has no account here; readable by workspace owners and admins, written by the import job and the claim function.';

CREATE TABLE app.import_map (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('slack', 'mattermost')),
  kind         text NOT NULL CHECK (kind IN ('channel', 'direct', 'message')),
  source_id    text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 400),
  target_id    uuid NOT NULL,
  run_id       uuid REFERENCES app.import_runs (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source, kind, source_id)
);
CREATE INDEX import_map_run ON app.import_map (run_id) WHERE run_id IS NOT NULL;
COMMENT ON TABLE app.import_map IS 'rls: system — S: which channel, direct conversation or message here each id of an imported archive became; read and written only by the import job.';

-- Row level security -----------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.import_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY import_runs_select ON app.import_runs FOR SELECT
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY import_runs_insert ON app.import_runs FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin') AND created_by = (SELECT app.actor())));
CREATE POLICY import_runs_update ON app.import_runs FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY import_runs_delete ON app.import_runs FOR DELETE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, DELETE ON app.import_runs TO manythreads_app;
GRANT INSERT (workspace_id, source, team_id, status, file_name, size_bytes, sha256, blob_key, created_by) ON app.import_runs TO manythreads_app;
GRANT UPDATE (status, started_by, started_at, cancel_requested, error, updated_at, blob_key) ON app.import_runs TO manythreads_app;

ALTER TABLE app.import_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.import_people FORCE ROW LEVEL SECURITY;
CREATE POLICY import_people_select ON app.import_people FOR SELECT
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY import_people_system ON app.import_people FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.import_people TO manythreads_app;

ALTER TABLE app.import_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.import_map FORCE ROW LEVEL SECURITY;
CREATE POLICY import_map_system ON app.import_map FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- Acting as the author of an imported message ------------------------------------------------------------------------------------------------------------
-- The import job runs as the system actor and writes each message AS its author, so the row, the reactions and the direct conversation belong to the right
-- actor. Only the system role may call this, and only for a person of this workspace or one of this plugin's placeholders: never for a bot or a webhook.
CREATE FUNCTION app.import_act_as(p_actor uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the import job acts as an imported author' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.actors a
     WHERE a.id = p_actor AND a.workspace_id = app.workspace_id()
       AND (a.kind = 'person' OR (a.kind = 'system' AND EXISTS (SELECT 1 FROM app.import_people ip WHERE ip.actor_id = a.id)))
  ) THEN
    RAISE EXCEPTION 'that actor cannot be an imported author' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('app.actor_id', p_actor::text, true);
  RETURN p_actor;
END
$$;

-- Naming a placeholder ------------------------------------------------------------------------------------------------------------------------------------
-- The same function as before (reminders 0003, which this plugin runs after) plus one join: a placeholder's messages show its name followed by "(imported)",
-- so nobody mistakes it for a member. The return type is the same, so the function is replaced in place; owner and grants are unchanged.
CREATE OR REPLACE FUNCTION app.message_authors(p_message_ids uuid[])
  RETURNS TABLE (actor_id uuid, display_name text, kind text, sender text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_visible uuid[];
BEGIN
  IF p_message_ids IS NULL OR cardinality(p_message_ids) = 0 OR app.actor() IS NULL THEN
    RETURN;
  END IF;
  IF session_user = 'manythreads_system' THEN
    v_visible := ARRAY(SELECT m.channel_id FROM app.messages m WHERE m.id = ANY (p_message_ids[1:500]));
  ELSE
    v_visible := app.visible_channel_ids('read');
  END IF;
  IF cardinality(v_visible) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.id,
         CASE a.kind
           WHEN 'person' THEN coalesce(p.display_name, 'Someone')
           WHEN 'bot' THEN coalesce(b.name, b.slug, 'Bot')
           ELSE coalesce(CASE WHEN w.emoji IS NULL THEN w.name ELSE w.emoji || ' ' || w.name END,
                         CASE WHEN rs.actor_id IS NOT NULL THEN 'Reminders' END,
                         ip.name || ' (imported)', 'System')
         END,
         a.kind,
         CASE WHEN a.kind <> 'system' THEN NULL WHEN rs.actor_id IS NOT NULL THEN 'reminders' WHEN w.actor_id IS NOT NULL THEN 'webhook' END
    FROM (SELECT DISTINCT m.author_id
            FROM app.messages m
           WHERE m.id = ANY (p_message_ids[1:500]) AND m.channel_id = ANY (v_visible)) x
    JOIN app.actors a ON a.id = x.author_id AND a.workspace_id = app.workspace_id()
    LEFT JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id AND p.workspace_id = a.workspace_id
    LEFT JOIN app.bots b ON a.kind = 'bot' AND b.id = a.ref_id AND b.workspace_id = a.workspace_id
    LEFT JOIN app.webhooks w ON a.kind = 'system' AND w.actor_id = a.id AND w.workspace_id = a.workspace_id
    LEFT JOIN app.reminder_senders rs ON a.kind = 'system' AND rs.actor_id = a.id AND rs.workspace_id = a.workspace_id
    LEFT JOIN app.import_people ip ON a.kind = 'system' AND ip.actor_id = a.id AND ip.workspace_id = a.workspace_id;
END
$$;

-- Claiming ------------------------------------------------------------------------------------------------------------------------------------------------
-- When an email address of a person becomes verified (or a person who already has a verified address first gets an actor), every unclaimed placeholder with
-- that address gives its messages and reactions to the person. One statement per table, in the same transaction as the verification, so there is no moment
-- when a message has two owners or none. A person who already reacted to a message keeps one reaction. One event per placeholder says how many messages moved.
CREATE FUNCTION app.import_claim_for_person(p_person uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws     uuid;
  v_actor  uuid;
  ph       app.import_people;
  v_moved  integer;
  v_total  integer := 0;
  v_event  uuid;
  v_prev   text;
BEGIN
  SELECT p.workspace_id INTO v_ws FROM app.people p WHERE p.id = p_person;
  SELECT a.id INTO v_actor FROM app.actors a WHERE a.kind = 'person' AND a.ref_id = p_person AND a.workspace_id = v_ws;
  IF v_ws IS NULL OR v_actor IS NULL THEN
    RETURN 0;
  END IF;
  FOR ph IN
    SELECT ip.* FROM app.import_people ip
     WHERE ip.workspace_id = v_ws AND ip.claimed_at IS NULL AND ip.email IS NOT NULL
       AND ip.email IN (SELECT lower(e.email) FROM app.person_emails e WHERE e.person_id = p_person AND e.verified_at IS NOT NULL)
     ORDER BY ip.id
       FOR UPDATE OF ip
  LOOP
    UPDATE app.messages SET author_id = v_actor WHERE author_id = ph.actor_id;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    INSERT INTO app.message_reactions (message_id, actor_id, emoji, channel_id, created_at)
      SELECT r.message_id, v_actor, r.emoji, r.channel_id, r.created_at FROM app.message_reactions r WHERE r.actor_id = ph.actor_id
      ON CONFLICT DO NOTHING;
    DELETE FROM app.message_reactions WHERE actor_id = ph.actor_id;
    UPDATE app.import_people SET claimed_by = p_person, claimed_at = now() WHERE id = ph.id;
    v_total := v_total + v_moved;
    v_event := uuidv7();
    INSERT INTO app.events (id, workspace_id, team_id, actor_id, type, schema_version, payload)
    VALUES (v_event, v_ws, NULL, v_actor, 'import.person.claimed', 1,
            jsonb_build_object('source', ph.source, 'personId', p_person, 'placeholderActorId', ph.actor_id, 'messages', v_moved, 'at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    -- app.enqueue_outbox only fans out events the current actor wrote: act as the person for that one call
    v_prev := current_setting('app.actor_id', true);
    PERFORM set_config('app.actor_id', v_actor::text, true);
    PERFORM app.enqueue_outbox(v_event);
    PERFORM set_config('app.actor_id', coalesce(v_prev, ''), true);
  END LOOP;
  RETURN v_total;
END
$$;

CREATE FUNCTION app.import_claim_on_email() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.verified_at IS NOT NULL THEN
    PERFORM app.import_claim_for_person(NEW.person_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.import_claim_on_actor() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.kind = 'person' THEN
    PERFORM app.import_claim_for_person(NEW.ref_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER import_claim_email_insert AFTER INSERT ON app.person_emails
  FOR EACH ROW WHEN (NEW.verified_at IS NOT NULL) EXECUTE FUNCTION app.import_claim_on_email();
CREATE TRIGGER import_claim_email_update AFTER UPDATE OF verified_at ON app.person_emails
  FOR EACH ROW WHEN (NEW.verified_at IS NOT NULL AND OLD.verified_at IS NULL) EXECUTE FUNCTION app.import_claim_on_email();
CREATE TRIGGER import_claim_actor AFTER INSERT ON app.actors
  FOR EACH ROW WHEN (NEW.kind = 'person') EXECUTE FUNCTION app.import_claim_on_actor();

-- Ownership and grants ---------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.import_act_as(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.import_claim_for_person(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.import_claim_on_email() OWNER TO manythreads_system;
ALTER FUNCTION app.import_claim_on_actor() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.import_act_as(uuid), app.import_claim_for_person(uuid), app.import_claim_on_email(), app.import_claim_on_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_act_as(uuid), app.import_claim_for_person(uuid) TO manythreads_system;
