-- webhooks 0003: API tokens and outgoing webhooks (PLAN P14-14). Forward-only: never edit once applied.
--
-- An INTEGRATION is a row of app.webhooks (migration 0001): it already has what an integration needs, namely a name, an emoji, its own author actor, a
-- creator, usage counters and a switch-off. Messages it writes carry the Webhook mark and the integration's name through app.message_authors, which
-- joins the webhooks table by actor, so nothing about authors changes here. The new column `kind` says which sort of integration the row is:
--
--   incoming  the secret address `/hooks/<id>/<secret>` (0001): a program posts into the channel
--   api       a token for the Slack-shaped web API: a script posts, edits its own messages and reacts, in the channels the lead picked
--   outgoing  a channel's messages that start with, or contain, a trigger word are sent to an address, and the answer is posted back
--
-- Four tables hold what a kind needs (every one has the webhook's team, so the same lead-or-admin read rule as app.webhooks applies):
--   webhook_api         the methods a token is limited to (the token's hash is in webhook_secrets, like an incoming secret)
--   webhook_channels    the channels a token may reach (the channel it was made in, and up to nine more of the same team)
--   webhook_outgoing    the address, trigger words, matching rule, the verification token, the sealed signing secret and the delivery counters
--   webhook_deliveries  one row per (outgoing webhook, message): the guard that a message is sent once, and the record of a retry or a dead letter
-- Writes go through the definer function below or the system role, exactly like 0001.

ALTER TABLE app.webhooks ADD COLUMN kind text NOT NULL DEFAULT 'incoming' CHECK (kind IN ('incoming', 'api', 'outgoing'));
ALTER TABLE app.webhooks ADD COLUMN call_count bigint NOT NULL DEFAULT 0 CHECK (call_count >= 0);
-- the message-posted subscriber asks "does this channel have a live outgoing webhook?" for every message
CREATE INDEX webhooks_outgoing_channel ON app.webhooks (channel_id) WHERE kind = 'outgoing' AND revoked_at IS NULL;
-- a call of the Slack-shaped API presents only its token, so the integration is found by the token's hash (256 random bits: the lookup tells nothing)
CREATE INDEX webhook_secrets_hash ON app.webhook_secrets (secret_hash);

CREATE TABLE app.webhook_api (
  webhook_id   uuid PRIMARY KEY REFERENCES app.webhooks (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  scopes       text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 4 AND scopes <@ ARRAY['chat.postMessage', 'chat.update', 'reactions.add', 'reactions.remove']::text[])
);
CREATE INDEX webhook_api_workspace ON app.webhook_api (workspace_id);
CREATE INDEX webhook_api_team ON app.webhook_api (team_id);
COMMENT ON TABLE app.webhook_api IS 'rls: team — T: the methods an API token may call; the team''s leads and workspace admins read it, every write is a definer function or the system role.';

CREATE TABLE app.webhook_channels (
  webhook_id   uuid NOT NULL REFERENCES app.webhooks (id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  position     smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (webhook_id, channel_id)
);
CREATE INDEX webhook_channels_channel ON app.webhook_channels (channel_id);
CREATE INDEX webhook_channels_workspace ON app.webhook_channels (workspace_id);
CREATE INDEX webhook_channels_team ON app.webhook_channels (team_id);
COMMENT ON TABLE app.webhook_channels IS 'rls: team — T: the channels an API token reaches (position 0 is the channel it was made in); the team''s leads and workspace admins read it, every write is a definer function or the system role.';

CREATE TABLE app.webhook_outgoing (
  webhook_id          uuid PRIMARY KEY REFERENCES app.webhooks (id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id             uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  url                 text NOT NULL CHECK (char_length(url) BETWEEN 8 AND 2000),
  trigger_words       text[] NOT NULL CHECK (cardinality(trigger_words) BETWEEN 1 AND 10),
  match_mode          text NOT NULL DEFAULT 'starts' CHECK (match_mode IN ('starts', 'contains')),
  -- sent in every call as `token`; not a secret (the signature is the proof), so it is kept readable and the lead can see it
  verification_token  text NOT NULL CHECK (char_length(verification_token) BETWEEN 16 AND 100),
  -- the sealed signing secret (app.secrets), or NULL
  signing_secret_id   uuid REFERENCES app.secrets (id) ON DELETE SET NULL,
  enabled             boolean NOT NULL DEFAULT true,
  delivered_count     integer NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  failed_count        integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  last_delivery_at    timestamptz,
  last_delivery_status text CHECK (last_delivery_status IN ('delivered', 'retrying', 'dead')),
  last_error          text CHECK (last_error IS NULL OR char_length(last_error) <= 60)
);
CREATE INDEX webhook_outgoing_workspace ON app.webhook_outgoing (workspace_id);
CREATE INDEX webhook_outgoing_team ON app.webhook_outgoing (team_id);
CREATE INDEX webhook_outgoing_signing ON app.webhook_outgoing (signing_secret_id) WHERE signing_secret_id IS NOT NULL;
COMMENT ON TABLE app.webhook_outgoing IS 'rls: team — T: the address, trigger words and delivery counters of an outgoing webhook; the team''s leads and workspace admins read it (the signing secret is only an id of a sealed secret), every write is the system role.';

CREATE TABLE app.webhook_deliveries (
  webhook_id   uuid NOT NULL REFERENCES app.webhooks (id) ON DELETE CASCADE,
  message_id   uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  status       text NOT NULL CHECK (status IN ('delivered', 'retrying', 'dead')),
  attempts     smallint NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  reason       text CHECK (reason IS NULL OR char_length(reason) <= 60),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (webhook_id, message_id)
);
CREATE INDEX webhook_deliveries_workspace ON app.webhook_deliveries (workspace_id);
CREATE INDEX webhook_deliveries_updated ON app.webhook_deliveries USING brin (updated_at);
COMMENT ON TABLE app.webhook_deliveries IS 'rls: system — S: one row per message sent to an outgoing webhook (sent once; the record of a retry or a dead letter); no privilege for manythreads_app. Rows older than two weeks are removed by the delivery job.';

ALTER TABLE app.webhook_api ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_api FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_api_select ON app.webhook_api FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
);
CREATE POLICY webhook_api_insert ON app.webhook_api FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY webhook_api_update ON app.webhook_api FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY webhook_api_delete ON app.webhook_api FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.webhook_api TO manythreads_app;

ALTER TABLE app.webhook_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_channels_select ON app.webhook_channels FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
);
CREATE POLICY webhook_channels_insert ON app.webhook_channels FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY webhook_channels_update ON app.webhook_channels FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY webhook_channels_delete ON app.webhook_channels FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.webhook_channels TO manythreads_app;

ALTER TABLE app.webhook_outgoing ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_outgoing FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_outgoing_select ON app.webhook_outgoing FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
);
CREATE POLICY webhook_outgoing_insert ON app.webhook_outgoing FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY webhook_outgoing_update ON app.webhook_outgoing FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY webhook_outgoing_delete ON app.webhook_outgoing FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.webhook_outgoing TO manythreads_app;

ALTER TABLE app.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_deliveries_system ON app.webhook_deliveries FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app

-- Make ------------------------------------------------------------------------------------------------------------------------
-- One door for both new kinds. The caller must be a lead of the channel's team or a workspace admin, for the channel in the path and for every extra
-- channel a token reaches (checked with app.lookup_channel_can, since inside a definer owned by the system role the is_* helpers are always true). For an
-- outgoing webhook the caller must also be able to READ the channel (a lead who is not in a private channel cannot send its messages out).
-- A channel holds at most 20 integrations of all kinds together (the limit of 0001 counts every row).
CREATE FUNCTION app.integrations_create(
  p_kind text, p_channel_id uuid, p_name text, p_emoji text, p_secret_hash bytea, p_scopes text[], p_more_channels uuid[],
  p_url text, p_triggers text[], p_match text, p_verification_token text
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
  v_more     uuid;
  v_count    integer;
  v_other    record;
BEGIN
  IF p_kind NOT IN ('api', 'outgoing') THEN
    RAISE EXCEPTION 'an integration is an api token or an outgoing webhook' USING ERRCODE = 'data_exception';
  END IF;
  IF p_kind = 'api' AND octet_length(p_secret_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'a token hash is 32 bytes' USING ERRCODE = 'data_exception';
  END IF;
  IF session_user <> 'manythreads_system' THEN
    IF v_ws IS NULL OR v_caller IS NULL
       OR NOT EXISTS (SELECT 1 FROM app.actors a WHERE a.id = v_caller AND a.workspace_id = v_ws AND a.kind = 'person')
       OR NOT coalesce(app.lookup_channel_can(p_channel_id, 'manage'), false) THEN
      RAISE EXCEPTION 'only a lead of the channel''s team or a workspace admin can make an integration' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- An outgoing webhook sends every matching message of the channel to an address outside. A lead or admin who is not in a private channel cannot read it, so
    -- they must not be able to wire it to an outside address either: the maker has to be able to read the channel.
    IF p_kind = 'outgoing' AND NOT coalesce(app.lookup_channel_can(p_channel_id, 'read'), false) THEN
      RAISE EXCEPTION 'You can only make an outgoing webhook for a channel you can read yourself, because it sends the channel''s messages to an address outside. Join the channel first.' USING ERRCODE = 'insufficient_privilege';
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
    VALUES (v_id, v_ws, v_team, p_channel_id, v_actor, p_name, NULLIF(p_emoji, ''), v_caller, v_name, p_kind);

  IF p_kind = 'api' THEN
    INSERT INTO app.webhook_secrets (webhook_id, secret_hash) VALUES (v_id, p_secret_hash);
    INSERT INTO app.webhook_api (webhook_id, workspace_id, team_id, scopes) VALUES (v_id, v_ws, v_team, p_scopes);
    INSERT INTO app.webhook_channels (webhook_id, channel_id, workspace_id, team_id, position) VALUES (v_id, p_channel_id, v_ws, v_team, 0);
    FOREACH v_more IN ARRAY coalesce(p_more_channels, ARRAY[]::uuid[]) LOOP
      IF v_more = p_channel_id THEN CONTINUE; END IF;
      SELECT c.team_id, c.archived_at INTO v_other FROM app.channels c WHERE c.id = v_more AND c.kind = 'channel' AND c.workspace_id = v_ws;
      IF v_other.team_id IS DISTINCT FROM v_team THEN
        RAISE EXCEPTION 'a token reaches channels of one team only' USING ERRCODE = 'check_violation';
      END IF;
      IF v_other.archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'An archived channel cannot be added to a token' USING ERRCODE = 'check_violation';
      END IF;
      IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_channel_can(v_more, 'manage'), false) THEN
        RAISE EXCEPTION 'only a lead of the channel''s team or a workspace admin can add a channel to a token' USING ERRCODE = 'insufficient_privilege';
      END IF;
      INSERT INTO app.webhook_channels (webhook_id, channel_id, workspace_id, team_id, position)
        VALUES (v_id, v_more, v_ws, v_team, 1) ON CONFLICT DO NOTHING;
    END LOOP;
    SELECT count(*) INTO v_count FROM app.webhook_channels WHERE webhook_id = v_id;
    IF v_count > 10 THEN
      RAISE EXCEPTION 'A token can reach at most 10 channels' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    INSERT INTO app.webhook_outgoing (webhook_id, workspace_id, team_id, url, trigger_words, match_mode, verification_token)
      VALUES (v_id, v_ws, v_team, p_url, p_triggers, p_match, p_verification_token);
  END IF;
  RETURN v_id;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.integrations_create(text, uuid, text, text, bytea, text[], uuid[], text, text[], text, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.integrations_create(text, uuid, text, text, bytea, text[], uuid[], text, text[], text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.integrations_create(text, uuid, text, text, bytea, text[], uuid[], text, text[], text, text) TO manythreads_app, manythreads_system;
