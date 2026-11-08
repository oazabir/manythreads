-- webhooks 0004: endpoints that an outside app (GitHub, Zendesk, Jira, ...) calls when something happens there (PLAN Bundle D, P16-10). Forward-only: never edit once applied.
--
-- A PROVIDER ENDPOINT is one more kind of integration: a row of app.webhooks with kind = 'provider'. A lead or admin makes one for a channel; the app is told its address
-- (`/hooks/apps/<id>`, no secret in the address: the app's signature is the proof) and, for most apps, a signing secret. What arrives is checked, remembered once, turned
-- into a short normalised event and handed to the bots that listen for it (the `webhook` trigger).
--
--   webhook_provider        one row per provider endpoint: which app, the short name a bot file uses (`slug`, unique among the team's live endpoints), the kinds of event
--                           it passes on (empty = all), the sealed signing secret and whether the app's one-time handshake (Asana) is done.
--   webhook_provider_events every verified delivery, normalised: the delivery key that makes a repeat a no-op (kept 7 days), the kind (`ticket.created`), a title, a link and
--                           the trimmed payload. System only: the text of an outside app is read by the router as the system role, never by a person's session.
--   webhook_provider_runs   the latch: one run of one bot for one event, so a repeat delivery or a second consumer never starts a second run.
--
-- The signing secret is a sealed row of app.secrets (the platform's own sealing), pointed at from webhook_provider like an outgoing webhook's.

ALTER TABLE app.webhooks DROP CONSTRAINT webhooks_kind_check;
ALTER TABLE app.webhooks ADD CONSTRAINT webhooks_kind_check CHECK (kind IN ('incoming', 'api', 'outgoing', 'provider'));

-- webhook_provider (T) ------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.webhook_provider (
  webhook_id        uuid PRIMARY KEY REFERENCES app.webhooks (id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id           uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('github', 'gitlab', 'jira', 'linear', 'zendesk', 'intercom', 'hubspot', 'asana', 'generic')),
  -- the name a BOT.md `webhook` trigger's `connection:` uses; unique among the team's live endpoints
  slug              text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  -- the kinds of event passed on (`ticket.created`, `issue.*`); empty = every kind the provider's reader understands
  event_filter      text[] NOT NULL DEFAULT '{}' CHECK (cardinality(event_filter) <= 20),
  -- the sealed signing secret (app.secrets), or NULL while none is set
  signing_secret_id uuid REFERENCES app.secrets (id) ON DELETE SET NULL,
  -- Asana: the one-time handshake answered; nothing else uses it
  handshake_at      timestamptz,
  -- false once the endpoint is revoked (kept by a trigger on app.webhooks), so the short name can be used again
  live              boolean NOT NULL DEFAULT true,
  rotated_at        timestamptz
);
CREATE UNIQUE INDEX webhook_provider_slug ON app.webhook_provider (team_id, slug) WHERE live;
CREATE INDEX webhook_provider_workspace ON app.webhook_provider (workspace_id);
CREATE INDEX webhook_provider_signing ON app.webhook_provider (signing_secret_id) WHERE signing_secret_id IS NOT NULL;
COMMENT ON TABLE app.webhook_provider IS 'rls: team — T: the app, short name and event filter of a provider endpoint; the team''s leads and workspace admins read it (the signing secret is only the id of a sealed secret), every write is a definer function or the system role.';

CREATE FUNCTION app.webhook_provider_live() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    UPDATE app.webhook_provider SET live = false WHERE webhook_id = NEW.id;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER webhook_provider_live AFTER UPDATE OF revoked_at ON app.webhooks
  FOR EACH ROW EXECUTE FUNCTION app.webhook_provider_live();

-- webhook_provider_events (S) ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.webhook_provider_events (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  webhook_id    uuid NOT NULL REFERENCES app.webhooks (id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('github', 'gitlab', 'jira', 'linear', 'zendesk', 'intercom', 'hubspot', 'asana', 'generic')),
  -- the provider's own delivery id, else sha256 of the body: a second delivery with the same key starts nothing
  delivery_key  text NOT NULL CHECK (char_length(delivery_key) BETWEEN 1 AND 200),
  -- the normalised kind: `ticket.created`, `issue.updated`, `pull_request.opened`, `push`
  kind          text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$' AND char_length(kind) <= 64),
  external_id   text CHECK (external_id IS NULL OR char_length(external_id) <= 200),
  url           text CHECK (url IS NULL OR char_length(url) <= 2000),
  title         text CHECK (title IS NULL OR char_length(title) <= 200),
  actor_label   text CHECK (actor_label IS NULL OR char_length(actor_label) <= 80),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 65536),
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, delivery_key)
);
CREATE INDEX webhook_provider_events_workspace ON app.webhook_provider_events (workspace_id);
CREATE INDEX webhook_provider_events_team ON app.webhook_provider_events (team_id);
CREATE INDEX webhook_provider_events_received ON app.webhook_provider_events USING brin (received_at);
COMMENT ON TABLE app.webhook_provider_events IS 'rls: system — S: verified deliveries from outside apps, normalised (kind, title, link, trimmed payload); no privilege for manythreads_app. Rows older than 7 days are removed by the plugin''s job.';

-- webhook_provider_runs (S) -----------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.webhook_provider_runs (
  event_id     uuid NOT NULL REFERENCES app.webhook_provider_events (id) ON DELETE CASCADE,
  bot_id       uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES app.bot_runs (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, bot_id),
  UNIQUE (run_id)
);
CREATE INDEX webhook_provider_runs_bot ON app.webhook_provider_runs (bot_id, created_at);
CREATE INDEX webhook_provider_runs_workspace ON app.webhook_provider_runs (workspace_id);
COMMENT ON TABLE app.webhook_provider_runs IS 'rls: system — S: the latch that starts at most one run of one bot for one delivery; no privilege for manythreads_app.';

-- Row level security ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.webhook_provider ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_provider FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_provider_select ON app.webhook_provider FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
);
CREATE POLICY webhook_provider_insert ON app.webhook_provider FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY webhook_provider_update ON app.webhook_provider FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY webhook_provider_delete ON app.webhook_provider FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.webhook_provider TO manythreads_app;

ALTER TABLE app.webhook_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_provider_events FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_provider_events_system ON app.webhook_provider_events FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app

ALTER TABLE app.webhook_provider_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_provider_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_provider_runs_system ON app.webhook_provider_runs FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app

-- Make ------------------------------------------------------------------------------------------------------------------------
-- The door for a provider endpoint (next to app.integrations_create, which stays as it was for the other kinds). The caller must be a lead of the channel's team or a workspace admin
-- and able to read the channel (the bots that answer post into it), checked with app.lookup_channel_can (inside a definer owned by the system role the is_* helpers are always
-- true). The slug is unique among the team's live endpoints. A channel holds at most 20 integrations of all kinds together, provider endpoints included.
CREATE FUNCTION app.integrations_create_provider(
  p_channel_id uuid, p_name text, p_emoji text, p_provider text, p_slug text, p_event_filter text[]
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws       uuid := app.workspace_id();
  v_caller   uuid := app.actor();
  v_team     uuid;
  v_archived timestamptz;
  v_id       uuid := uuidv7();
  v_actor    uuid;
  v_name     text;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    IF v_ws IS NULL OR v_caller IS NULL
       OR NOT EXISTS (SELECT 1 FROM app.actors a WHERE a.id = v_caller AND a.workspace_id = v_ws AND a.kind = 'person')
       OR NOT coalesce(app.lookup_channel_can(p_channel_id, 'manage'), false) THEN
      RAISE EXCEPTION 'only a lead of the channel''s team or a workspace admin can make an endpoint for an outside app' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT coalesce(app.lookup_channel_can(p_channel_id, 'read'), false) THEN
      RAISE EXCEPTION 'You can only make an endpoint for a channel you can read yourself. Join the channel first.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT c.team_id, c.archived_at, c.workspace_id INTO v_team, v_archived, v_ws
    FROM app.channels c WHERE c.id = p_channel_id AND c.kind = 'channel' AND c.team_id IS NOT NULL;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such channel' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'This channel is archived, so it cannot get an integration' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM app.webhooks w WHERE w.channel_id = p_channel_id AND w.revoked_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'A channel can have at most 20 webhooks, tokens and outgoing webhooks together. Switch one off that you no longer use.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.display_name INTO v_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id
   WHERE a.id = v_caller AND a.kind = 'person';
  INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('system', v_ws, v_id) RETURNING id INTO v_actor;
  INSERT INTO app.webhooks (id, workspace_id, team_id, channel_id, actor_id, name, emoji, created_by, created_by_name, kind)
    VALUES (v_id, v_ws, v_team, p_channel_id, v_actor, p_name, NULLIF(p_emoji, ''), v_caller, v_name, 'provider');
  INSERT INTO app.webhook_provider (webhook_id, workspace_id, team_id, provider, slug, event_filter)
    VALUES (v_id, v_ws, v_team, p_provider, p_slug, coalesce(p_event_filter, ARRAY[]::text[]));
  RETURN v_id;
END
$$;

-- Latch: one run of one bot for one delivery. True the first time, false for a repeat. System only (the router). ---------------------------------
CREATE FUNCTION app.webhooks_claim_run(p_event_id uuid, p_bot_id uuid, p_run_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws uuid;
  v_n  integer;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the platform starts runs from a delivery' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT e.workspace_id INTO v_ws FROM app.webhook_provider_events e WHERE e.id = p_event_id;
  IF v_ws IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO app.webhook_provider_runs (event_id, bot_id, run_id, workspace_id) VALUES (p_event_id, p_bot_id, p_run_id, v_ws)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$$;

-- What started this run -----------------------------------------------------------------------------------------------------------------------
-- The caller must read the channel the endpoint posts into (app.visible_channel_ids('read')); anyone else, and a run that no delivery started, gets no row. The system role
-- (a job) may read any. Never the payload, only what the card shows: the app, the endpoint's name, the kind, the title, the link, who did it, when it arrived and the first
-- 8 characters of the delivery key.
CREATE FUNCTION app.webhooks_run_origin(p_run_id uuid)
  RETURNS TABLE (provider text, endpoint_name text, kind text, title text, url text, actor_label text, received_at timestamptz, delivery_key text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT e.provider, w.name, e.kind, e.title, e.url, e.actor_label, e.received_at, left(e.delivery_key, 8)
    FROM app.webhook_provider_runs r
    JOIN app.webhook_provider_events e ON e.id = r.event_id
    JOIN app.webhooks w ON w.id = e.webhook_id
   WHERE r.run_id = p_run_id AND r.workspace_id = app.workspace_id()
     AND (session_user = 'manythreads_system' OR w.channel_id = ANY (app.visible_channel_ids('read')));
END
$$;

-- Revoke, replaced ---------------------------------------------------------------------------------------------------------------------------
-- 0001's revoke also hands back the id of a provider endpoint's sealed signing secret, so the caller deletes it. Same name, same arguments, same answer shape.
CREATE OR REPLACE FUNCTION app.webhooks_revoke(p_webhook_id uuid) RETURNS TABLE (signing_secret_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_channel uuid;
  v_signing uuid;
BEGIN
  SELECT w.channel_id INTO v_channel FROM app.webhooks w WHERE w.id = p_webhook_id AND w.revoked_at IS NULL AND w.workspace_id = app.workspace_id();
  IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_channel_can(v_channel, 'manage'), false) THEN
    RAISE EXCEPTION 'only a lead of the channel''s team or a workspace admin can revoke a webhook' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_channel IS NULL THEN
    RAISE EXCEPTION 'no such webhook' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT s.signing_secret_id INTO v_signing FROM app.webhook_secrets s WHERE s.webhook_id = p_webhook_id;
  IF v_signing IS NULL THEN
    SELECT p.signing_secret_id INTO v_signing FROM app.webhook_provider p WHERE p.webhook_id = p_webhook_id;
    UPDATE app.webhook_provider SET signing_secret_id = NULL WHERE webhook_id = p_webhook_id;
  END IF;
  DELETE FROM app.webhook_secrets WHERE webhook_id = p_webhook_id;
  UPDATE app.webhooks SET revoked_at = now(), signed = false WHERE id = p_webhook_id;
  RETURN QUERY SELECT v_signing;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.webhook_provider_live() OWNER TO manythreads_system;
ALTER FUNCTION app.integrations_create_provider(uuid, text, text, text, text, text[]) OWNER TO manythreads_system;
ALTER FUNCTION app.webhooks_claim_run(uuid, uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.webhooks_run_origin(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.webhooks_revoke(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.webhook_provider_live() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.integrations_create_provider(uuid, text, text, text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.webhooks_claim_run(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.webhooks_run_origin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.integrations_create_provider(uuid, text, text, text, text, text[]) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.webhooks_claim_run(uuid, uuid, uuid) TO manythreads_system;
GRANT EXECUTE ON FUNCTION app.webhooks_run_origin(uuid) TO manythreads_app, manythreads_system;
