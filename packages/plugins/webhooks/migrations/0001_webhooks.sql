-- webhooks 0001: incoming webhooks (PLAN P14-14). Forward-only: never edit once applied.
--
-- A webhook is a secret address that posts into ONE channel, written as the webhook and never as a person. Three pieces of data:
--
--   webhooks         the visible row: the channel, a name and an emoji, who made it, when it was last used and how. Read by the team's leads
--                    and by workspace admins (`readable_team_ids('manage')`, the hoisted idiom of kernel 0011); every write goes through the
--                    definer functions below or the system role. The secret is NOT here.
--   webhook_secrets  the sha256 of the current secret and the id of the sealed signing secret (app.secrets). System only: the public route
--                    resolves it as the system role, no request role ever reads it (like app.runner_tokens).
--   actors           each webhook is its own author: an actor of kind 'system' whose ref_id is the webhook id. Messages it posts carry that actor,
--                    so search, notifications, retention and row-level security treat them like any message. `app.message_authors` (replaced
--                    below, on top of bots 0013) names such an author by the webhook's name, with its emoji in front.
--
-- Three narrow SECURITY DEFINER doors, owned by manythreads_system (CLAUDE.md: non-system code reaches system tables through one). Inside a
-- definer owned by the system role the is_* helpers are always true, so the caller is checked with app.lookup_channel_can(…, 'manage') (a lead of
-- the channel's team or a workspace admin) and the actor row; the system role itself is recognised through session_user (idiom of bots 0002).

CREATE TABLE app.webhooks (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  actor_id     uuid NOT NULL REFERENCES app.actors (id),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  emoji        text CHECK (emoji IS NULL OR char_length(emoji) BETWEEN 1 AND 16),
  created_by   uuid REFERENCES app.actors (id),
  -- the maker's display name when it was made (a lead cannot read other people's rows; the name is shown in the list)
  created_by_name text CHECK (created_by_name IS NULL OR char_length(created_by_name) <= 200),
  -- whether a signing secret is set (the sealed secret itself is in webhook_secrets)
  signed       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  last_used_at timestamptz,
  last_status  text CHECK (last_status IN ('posted', 'ignored', 'failed')),
  posted_count integer NOT NULL DEFAULT 0 CHECK (posted_count >= 0)
);
CREATE INDEX webhooks_workspace ON app.webhooks (workspace_id);
CREATE INDEX webhooks_team ON app.webhooks (team_id);
CREATE INDEX webhooks_channel ON app.webhooks (channel_id) WHERE revoked_at IS NULL;
CREATE INDEX webhooks_actor ON app.webhooks (actor_id);
CREATE INDEX webhooks_created_by ON app.webhooks (created_by) WHERE created_by IS NOT NULL;
-- one live webhook per name in a channel, so a lead can tell them apart
CREATE UNIQUE INDEX webhooks_channel_name ON app.webhooks (channel_id, lower(name)) WHERE revoked_at IS NULL;
COMMENT ON TABLE app.webhooks IS 'rls: team — T: incoming webhooks of a channel; the team''s leads and workspace admins read them, every write is a definer function or the system role. The secret is in webhook_secrets (system only).';

CREATE TABLE app.webhook_secrets (
  webhook_id        uuid PRIMARY KEY REFERENCES app.webhooks (id) ON DELETE CASCADE,
  secret_hash       bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  rotated_at        timestamptz NOT NULL DEFAULT now(),
  signing_secret_id uuid REFERENCES app.secrets (id) ON DELETE SET NULL
);
CREATE INDEX webhook_secrets_signing ON app.webhook_secrets (signing_secret_id) WHERE signing_secret_id IS NOT NULL;
COMMENT ON TABLE app.webhook_secrets IS 'rls: system — S: sha256 of a webhook''s current secret and the id of its sealed signing secret (never the secrets); no privilege for manythreads_app, the public route resolves it as the system role.';

ALTER TABLE app.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY webhooks_select ON app.webhooks FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
);
CREATE POLICY webhooks_insert ON app.webhooks FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY webhooks_update ON app.webhooks FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY webhooks_delete ON app.webhooks FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.webhooks TO manythreads_app;

ALTER TABLE app.webhook_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_secrets_system ON app.webhook_secrets FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: a credential table the request role never reads

-- Make ------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION app.webhooks_create(p_channel_id uuid, p_name text, p_emoji text, p_secret_hash bytea) RETURNS uuid
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
  IF octet_length(p_secret_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'a webhook secret hash is 32 bytes' USING ERRCODE = 'data_exception';
  END IF;
  IF session_user <> 'manythreads_system' THEN
    IF v_ws IS NULL OR v_caller IS NULL
       OR NOT EXISTS (SELECT 1 FROM app.actors a WHERE a.id = v_caller AND a.workspace_id = v_ws AND a.kind = 'person')
       OR NOT coalesce(app.lookup_channel_can(p_channel_id, 'manage'), false) THEN
      RAISE EXCEPTION 'only a lead of the channel''s team or a workspace admin can make a webhook' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT c.team_id, c.archived_at, c.workspace_id INTO v_team, v_archived, v_ws
    FROM app.channels c WHERE c.id = p_channel_id AND c.kind = 'channel' AND c.team_id IS NOT NULL;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'no such channel' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'This channel is archived, so it cannot get a webhook' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM app.webhooks w WHERE w.channel_id = p_channel_id AND w.revoked_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'A channel can have at most 20 webhooks. Revoke one you no longer use.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.display_name INTO v_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id
   WHERE a.id = v_caller AND a.kind = 'person';
  INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('system', v_ws, v_id) RETURNING id INTO v_actor;
  INSERT INTO app.webhooks (id, workspace_id, team_id, channel_id, actor_id, name, emoji, created_by, created_by_name)
    VALUES (v_id, v_ws, v_team, p_channel_id, v_actor, p_name, NULLIF(p_emoji, ''), v_caller, v_name);
  INSERT INTO app.webhook_secrets (webhook_id, secret_hash) VALUES (v_id, p_secret_hash);
  RETURN v_id;
END
$$;

-- Act as the webhook: the one thing the public door needs the system role to do. A call has no session, so the post runs in a system transaction
-- (the secret was already checked); this switches the transaction's actor to the webhook's own, so the stored author of the message is the webhook.
-- Only the system role may call it, only for a live webhook of the transaction's own workspace, and the switch lasts to the end of the transaction.
CREATE FUNCTION app.webhooks_act_as(p_webhook_id uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the system role acts as a webhook' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT w.actor_id INTO v_actor FROM app.webhooks w
   WHERE w.id = p_webhook_id AND w.revoked_at IS NULL AND w.workspace_id = app.workspace_id();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'no such webhook' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('app.actor_id', v_actor::text, true);
  RETURN v_actor;
END
$$;

-- Rotate: the new hash replaces the old at once, so the old address answers "not found" from the next call. -------------------------
CREATE FUNCTION app.webhooks_rotate(p_webhook_id uuid, p_secret_hash bytea) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_channel uuid;
BEGIN
  IF octet_length(p_secret_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'a webhook secret hash is 32 bytes' USING ERRCODE = 'data_exception';
  END IF;
  SELECT w.channel_id INTO v_channel FROM app.webhooks w WHERE w.id = p_webhook_id AND w.revoked_at IS NULL AND w.workspace_id = app.workspace_id();
  IF session_user <> 'manythreads_system' AND NOT coalesce(app.lookup_channel_can(v_channel, 'manage'), false) THEN
    RAISE EXCEPTION 'only a lead of the channel''s team or a workspace admin can rotate a webhook' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_channel IS NULL THEN
    RAISE EXCEPTION 'no such webhook' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE app.webhook_secrets SET secret_hash = p_secret_hash, rotated_at = now() WHERE webhook_id = p_webhook_id;
END
$$;

-- Revoke: the webhook stays as a row (its old messages keep their author's name) but has no secret any more. Answers the id of the sealed
-- signing secret it had (or NULL) so the caller can delete it. ---------------------------------------------------------------------------
CREATE FUNCTION app.webhooks_revoke(p_webhook_id uuid) RETURNS TABLE (signing_secret_id uuid)
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
  DELETE FROM app.webhook_secrets WHERE webhook_id = p_webhook_id;
  UPDATE app.webhooks SET revoked_at = now(), signed = false WHERE id = p_webhook_id;
  RETURN QUERY SELECT v_signing;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.webhooks_create(uuid, text, text, bytea) OWNER TO manythreads_system;
ALTER FUNCTION app.webhooks_rotate(uuid, bytea) OWNER TO manythreads_system;
ALTER FUNCTION app.webhooks_revoke(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.webhooks_act_as(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.webhooks_create(uuid, text, text, bytea), app.webhooks_rotate(uuid, bytea), app.webhooks_revoke(uuid), app.webhooks_act_as(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.webhooks_act_as(uuid) TO manythreads_system;
GRANT EXECUTE ON FUNCTION app.webhooks_create(uuid, text, text, bytea), app.webhooks_rotate(uuid, bytea), app.webhooks_revoke(uuid) TO manythreads_app, manythreads_system;

-- Naming the author: bots 0013's body plus "a webhook is named by its own row" (emoji first when it has one). The owner and the grant are
-- unchanged (CREATE OR REPLACE keeps both); the join is on the actor, so a revoked webhook keeps naming its old messages.
CREATE OR REPLACE FUNCTION app.message_authors(p_message_ids uuid[])
  RETURNS TABLE (actor_id uuid, display_name text, kind text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_visible uuid[];
BEGIN
  IF p_message_ids IS NULL OR cardinality(p_message_ids) = 0 OR app.actor() IS NULL THEN
    RETURN;
  END IF;
  v_visible := app.visible_channel_ids('read');
  IF cardinality(v_visible) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.id,
         CASE a.kind
           WHEN 'person' THEN coalesce(p.display_name, 'Someone')
           WHEN 'bot' THEN coalesce(b.name, b.slug, 'Bot')
           ELSE coalesce(CASE WHEN w.emoji IS NULL THEN w.name ELSE w.emoji || ' ' || w.name END, 'System')
         END,
         a.kind
    FROM (SELECT DISTINCT m.author_id
            FROM app.messages m
           WHERE m.id = ANY (p_message_ids[1:500]) AND m.channel_id = ANY (v_visible)) x
    JOIN app.actors a ON a.id = x.author_id AND a.workspace_id = app.workspace_id()
    LEFT JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id AND p.workspace_id = a.workspace_id
    LEFT JOIN app.bots b ON a.kind = 'bot' AND b.id = a.ref_id AND b.workspace_id = a.workspace_id
    LEFT JOIN app.webhooks w ON a.kind = 'system' AND w.actor_id = a.id AND w.workspace_id = a.workspace_id;
END
$$;

-- The message path also runs in a system transaction when a webhook posts (it names the author of the message it pushes live), so the system role may call it too.
GRANT EXECUTE ON FUNCTION app.message_authors(uuid[]) TO manythreads_system;
