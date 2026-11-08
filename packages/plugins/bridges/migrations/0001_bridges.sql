-- bridges 0001: chat apps (Telegram, WhatsApp, Slack, Microsoft Teams) joined to manythreads (PLAN Bundle D, decisions D23-D29). Forward-only: never edit once applied.
--
-- An admin connects the workspace to ONE chat app account per service (a Telegram bot, a WhatsApp number, a Slack app, a Teams bot). Then:
--   * a person links their own chat user to their manythreads account with a short code (once, ten minutes). Only a linked person is ever heard: a message from anybody else is
--     dropped before any text is stored, counted, and answered at most once an hour with "link your account first";
--   * a lead links a PUBLIC channel to a group or channel of the chat app with a code posted in that chat;
--   * a linked person can talk to a bot in a private chat, which is their direct message with that bot.
--
--   bridge_accounts         the connection to one service: its state, its public handle, counters. Admins read and write.
--   bridge_secrets          SYSTEM ONLY. Pointers to the sealed credentials (bot token, app secret, signing secret, inbound secret). Never returned by any route.
--   bridge_identities       a person <-> the chat user they proved is theirs. The person reads and removes their own; admins read and remove any.
--   bridge_link_codes       SYSTEM ONLY. sha256 of a code, who asked for it and what for. Ten minutes, once.
--   bridge_links            a public channel <-> an outside chat. Readers of the channel read it; leads remove it; made only by redeeming a code.
--   bridge_dm_sessions      a linked person's private chat <-> their DM with a bot. The person reads their own.
--   bridge_messages         SYSTEM ONLY. Ids only: the dedupe of what the chat app sent twice, the map between the two sides' message ids, the outbound queue. No text.
--   bridge_unlinked_chats   SYSTEM ONLY. Counters per chat that wrote without being linked, and when it was last answered. No text, no names.

CREATE TABLE app.bridge_accounts (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('telegram', 'whatsapp', 'slack', 'teams')),
  status           text NOT NULL DEFAULT 'off' CHECK (status IN ('off', 'on', 'attention')),
  display_name     text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  -- the public name people type to reach it (@Bot name, a phone number, a Slack app name); shown on the Account page. Never a secret.
  handle           text CHECK (handle IS NULL OR char_length(handle) BETWEEN 1 AND 200),
  -- the provider's own id of the app / number / bot (a public id, never a token)
  external_app_id  text CHECK (external_app_id IS NULL OR char_length(external_app_id) BETWEEN 1 AND 200),
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  inbound_count    bigint NOT NULL DEFAULT 0 CHECK (inbound_count >= 0),
  outbound_count   bigint NOT NULL DEFAULT 0 CHECK (outbound_count >= 0),
  dropped_count    bigint NOT NULL DEFAULT 0 CHECK (dropped_count >= 0),
  last_error       text CHECK (last_error IS NULL OR char_length(last_error) <= 400),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider),
  UNIQUE (id, workspace_id)
);
COMMENT ON TABLE app.bridge_accounts IS 'rls: workspace — W: read and written by workspace owners and admins (and the system, which keeps the counters); a person who wants to link reads only app.bridges_available(). Credentials live in bridge_secrets, never here.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id ON app.bridge_accounts
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

CREATE TABLE app.bridge_secrets (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  account_id   uuid NOT NULL,
  -- what the credential is called: the bot token (Telegram bot token, Slack bot token, WhatsApp access token), the app secret (WhatsApp app secret, Teams client secret),
  -- the signing secret (Slack) and the inbound secret (the word the chat app sends back on every call: Telegram's secret token, WhatsApp's verify token)
  name         text NOT NULL CHECK (name IN ('bot_token', 'app_secret', 'signing_secret', 'inbound_secret')),
  secret_id    uuid NOT NULL REFERENCES app.secrets (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name),
  FOREIGN KEY (account_id, workspace_id) REFERENCES app.bridge_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX bridge_secrets_workspace ON app.bridge_secrets (workspace_id);
CREATE INDEX bridge_secrets_secret ON app.bridge_secrets (secret_id);
COMMENT ON TABLE app.bridge_secrets IS 'rls: system — S: references to the sealed credentials of a chat app account (app.secrets); no privilege for manythreads_app, never returned by any API.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, secret_id ON app.bridge_secrets
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

CREATE TABLE app.bridge_identities (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  account_id       uuid NOT NULL,
  person_id        uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  external_user_id text NOT NULL CHECK (char_length(external_user_id) BETWEEN 1 AND 200),
  -- how the person is shown on their Account page ("@nadia on Telegram"); the chat app's own display text, trimmed
  external_label   text CHECK (external_label IS NULL OR char_length(external_label) <= 120),
  verified_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- one person per chat user, one chat user per person on an account
  UNIQUE (account_id, external_user_id),
  UNIQUE (account_id, person_id),
  FOREIGN KEY (account_id, workspace_id) REFERENCES app.bridge_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX bridge_identities_person ON app.bridge_identities (person_id);
CREATE INDEX bridge_identities_workspace ON app.bridge_identities (workspace_id);
COMMENT ON TABLE app.bridge_identities IS 'rls: person — P: a person reads and removes their own link; workspace owners and admins read and remove any; made only by redeeming a code (app.bridges_link_identity, system).';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, person_id ON app.bridge_identities
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

CREATE TABLE app.bridge_link_codes (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  account_id   uuid NOT NULL,
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  -- `identity`: links the person's chat user. `channel`: links a public channel to the chat it is typed in.
  purpose      text NOT NULL CHECK (purpose IN ('identity', 'channel')),
  channel_id   uuid REFERENCES app.channels (id) ON DELETE CASCADE,
  code_hash    text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code_hash),
  CONSTRAINT bridge_link_codes_shape CHECK ((purpose = 'channel') = (channel_id IS NOT NULL)),
  FOREIGN KEY (account_id, workspace_id) REFERENCES app.bridge_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX bridge_link_codes_person ON app.bridge_link_codes (person_id, created_at DESC);
CREATE INDEX bridge_link_codes_account ON app.bridge_link_codes (account_id);
CREATE INDEX bridge_link_codes_channel ON app.bridge_link_codes (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX bridge_link_codes_workspace ON app.bridge_link_codes (workspace_id);
CREATE INDEX bridge_link_codes_expiry ON app.bridge_link_codes (expires_at);
COMMENT ON TABLE app.bridge_link_codes IS 'rls: system — S: the sha256 of a short-lived code (ten minutes, once) and who asked for it; made through app.bridges_issue_code, redeemed by the system role; no privilege for manythreads_app.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, person_id ON app.bridge_link_codes
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

CREATE TABLE app.bridge_links (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id          uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  account_id       uuid NOT NULL,
  channel_id       uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  external_chat_id text NOT NULL CHECK (char_length(external_chat_id) BETWEEN 1 AND 200),
  external_label   text CHECK (external_label IS NULL OR char_length(external_label) <= 120),
  linked_by        uuid REFERENCES app.people (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- an outside chat belongs to one channel: what it says has one place to go
  UNIQUE (account_id, external_chat_id),
  UNIQUE (account_id, channel_id, external_chat_id),
  FOREIGN KEY (account_id, workspace_id) REFERENCES app.bridge_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX bridge_links_channel ON app.bridge_links (channel_id);
CREATE INDEX bridge_links_team ON app.bridge_links (team_id);
CREATE INDEX bridge_links_workspace ON app.bridge_links (workspace_id);
CREATE INDEX bridge_links_linked_by ON app.bridge_links (linked_by) WHERE linked_by IS NOT NULL;
COMMENT ON TABLE app.bridge_links IS 'rls: team — C: a public channel joined to an outside chat; readable by whoever reads the channel (app.visible_channel_ids), removed by the team''s leads and workspace admins, made only by redeeming a code (app.bridges_link_channel, system).';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id ON app.bridge_links
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

CREATE TABLE app.bridge_dm_sessions (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  account_id       uuid NOT NULL,
  person_id        uuid NOT NULL,
  external_chat_id text NOT NULL CHECK (char_length(external_chat_id) BETWEEN 1 AND 200),
  -- the bot the person is talking to, and the conversation channel their messages go to
  bot_id           uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  channel_id       uuid REFERENCES app.channels (id) ON DELETE SET NULL,
  -- WhatsApp only answers within 24 hours of the person's last message: when that was
  last_inbound_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, person_id),
  UNIQUE (account_id, external_chat_id),
  -- unlinking the person ends the session
  FOREIGN KEY (account_id, person_id) REFERENCES app.bridge_identities (account_id, person_id) ON DELETE CASCADE
);
CREATE INDEX bridge_dm_sessions_workspace ON app.bridge_dm_sessions (workspace_id);
CREATE INDEX bridge_dm_sessions_person ON app.bridge_dm_sessions (person_id);
CREATE INDEX bridge_dm_sessions_bot ON app.bridge_dm_sessions (bot_id);
CREATE INDEX bridge_dm_sessions_channel ON app.bridge_dm_sessions (channel_id) WHERE channel_id IS NOT NULL;
COMMENT ON TABLE app.bridge_dm_sessions IS 'rls: person — P: a person reads their own private-chat session (which bot, which chat); written by the system role only.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, person_id ON app.bridge_dm_sessions
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

CREATE TABLE app.bridge_messages (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  account_id          uuid NOT NULL,
  -- `in`: the chat app sent it to us. `out`: we send it to the chat app.
  direction           text NOT NULL CHECK (direction IN ('in', 'out')),
  -- the chat app's id of the update / event / message it delivered; the dedupe key of what it sent twice (inbound only)
  provider_update_id  text CHECK (provider_update_id IS NULL OR char_length(provider_update_id) BETWEEN 1 AND 300),
  -- received: an inbound message handled. pending / waiting / sent / dead: the life of an outbound one (waiting: WhatsApp's 24-hour window is closed).
  status              text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'pending', 'waiting', 'sent', 'dead')),
  channel_id          uuid,
  message_id          uuid,
  external_chat_id    text CHECK (external_chat_id IS NULL OR char_length(external_chat_id) <= 200),
  external_message_id text CHECK (external_message_id IS NULL OR char_length(external_message_id) <= 300),
  attempts            smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  next_attempt_at     timestamptz,
  error               text CHECK (error IS NULL OR char_length(error) <= 200),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bridge_messages_shape CHECK ((direction = 'in') = (provider_update_id IS NOT NULL) AND (direction = 'out' OR status = 'received')),
  FOREIGN KEY (account_id, workspace_id) REFERENCES app.bridge_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX bridge_messages_dedupe ON app.bridge_messages (account_id, provider_update_id) WHERE direction = 'in';
CREATE INDEX bridge_messages_map ON app.bridge_messages (account_id, external_chat_id, external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX bridge_messages_message ON app.bridge_messages (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX bridge_messages_due ON app.bridge_messages (next_attempt_at) WHERE status = 'pending';
CREATE INDEX bridge_messages_workspace ON app.bridge_messages (workspace_id);
CREATE INDEX bridge_messages_created ON app.bridge_messages USING brin (created_at);
COMMENT ON TABLE app.bridge_messages IS 'rls: system — S: ids only (no text): what a chat app sent twice, the map between its message ids and ours, the outbound queue with its retries; no privilege for manythreads_app.';

CREATE TABLE app.bridge_unlinked_chats (
  account_id       uuid NOT NULL,
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  external_chat_id text NOT NULL CHECK (char_length(external_chat_id) BETWEEN 1 AND 200),
  dropped_count    integer NOT NULL DEFAULT 1 CHECK (dropped_count >= 0),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  -- the "link your account" reply goes at most once an hour per chat
  last_replied_at  timestamptz,
  PRIMARY KEY (account_id, external_chat_id),
  FOREIGN KEY (account_id, workspace_id) REFERENCES app.bridge_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX bridge_unlinked_chats_workspace ON app.bridge_unlinked_chats (workspace_id);
CREATE INDEX bridge_unlinked_chats_seen ON app.bridge_unlinked_chats USING brin (last_seen_at);
COMMENT ON TABLE app.bridge_unlinked_chats IS 'rls: system — S: per chat that wrote without being linked: a count and when it was last answered; no text, no names; no privilege for manythreads_app.';

-- An account is switched on only while its bot token is stored -----------------------------------------------------------------------------------
-- The check belongs to the database: whichever writer turns an account `on` (the admin page, a job), the account has a bot token or it stays `off`.
CREATE FUNCTION app.bridge_accounts_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- identity columns never change
    IF NEW.workspace_id <> OLD.workspace_id OR NEW.provider <> OLD.provider THEN
      RAISE EXCEPTION 'an account''s workspace and service cannot change' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'on' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'on') THEN
    IF NOT EXISTS (SELECT 1 FROM app.bridge_secrets s WHERE s.account_id = NEW.id AND s.name = 'bot_token') THEN
      RAISE EXCEPTION 'Add the bot token before turning this chat app on' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER bridge_accounts_guard BEFORE INSERT OR UPDATE ON app.bridge_accounts
  FOR EACH ROW EXECUTE FUNCTION app.bridge_accounts_guard();

-- A link is only for a public, live channel of the account's workspace -----------------------------------------------------------------------------
CREATE FUNCTION app.bridge_links_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  c app.channels;
BEGIN
  SELECT * INTO c FROM app.channels WHERE id = NEW.channel_id;
  IF NOT FOUND OR c.workspace_id <> NEW.workspace_id OR c.kind <> 'channel' OR c.team_id IS DISTINCT FROM NEW.team_id THEN
    RAISE EXCEPTION 'a chat can only be joined to a channel of a team in this workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF c.private THEN
    RAISE EXCEPTION 'Only public channels can be joined to a chat app. Private channels stay inside manythreads.' USING ERRCODE = 'check_violation';
  END IF;
  IF c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'This channel is archived' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bridge_links_guard BEFORE INSERT ON app.bridge_links
  FOR EACH ROW EXECUTE FUNCTION app.bridge_links_guard();

-- A code to link a chat user, or a channel ----------------------------------------------------------------------------------------------------------
-- The caller (a signed-in person who is not a guest) asks for a code for an account that is `on`. The route hands in only the sha256 of the code it shows the person.
-- An `identity` code ends the person's earlier unused ones for the account (they stay, used, so the count sees them); at most five codes of either purpose per person in ten minutes. A `channel` code is for a
-- public channel of a team the caller leads (or any, for a workspace admin) and can post in. Answers when the code stops working.
CREATE FUNCTION app.bridges_issue_code(p_account_id uuid, p_purpose text, p_channel_id uuid, p_code_hash text) RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ws      uuid := app.workspace_id();
  v_person  uuid := app.person_id();
  v_role    text := app.lookup_workspace_role();
  v_acct    app.bridge_accounts;
  c         app.channels;
  v_expires timestamptz := now() + interval '10 minutes';
BEGIN
  IF v_ws IS NULL OR v_person IS NULL OR v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'only a member of the workspace can link a chat app' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_purpose NOT IN ('identity', 'channel') THEN
    RAISE EXCEPTION 'unknown purpose' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_acct FROM app.bridge_accounts WHERE id = p_account_id AND workspace_id = v_ws;
  IF NOT FOUND OR v_acct.status <> 'on' THEN
    RAISE EXCEPTION 'This chat app is not turned on' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_purpose = 'channel' THEN
    SELECT * INTO c FROM app.channels WHERE id = p_channel_id AND workspace_id = v_ws;
    IF NOT FOUND OR c.kind <> 'channel' THEN
      RAISE EXCEPTION 'no such channel' USING ERRCODE = 'no_data_found';
    END IF;
    IF c.private THEN
      RAISE EXCEPTION 'Only public channels can be joined to a chat app' USING ERRCODE = 'check_violation';
    END IF;
    IF c.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'This channel is archived' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (v_role IN ('owner', 'admin') OR app.lookup_team_role(c.team_id) = 'lead') OR NOT coalesce(app.lookup_channel_can(c.id, 'post'), false) THEN
      RAISE EXCEPTION 'only a lead of the team who is in the channel can join it to a chat app' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF p_channel_id IS NOT NULL THEN
    RAISE EXCEPTION 'an identity code names no channel' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bridge_codes:' || v_person::text, 0));
  IF (SELECT count(*) FROM app.bridge_link_codes k WHERE k.person_id = v_person AND k.created_at > now() - interval '10 minutes') >= 5 THEN
    RAISE EXCEPTION 'Too many codes just now. Wait a few minutes and try again.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_purpose = 'identity' THEN
    -- the earlier ones stop working but stay, so the count above sees them
    UPDATE app.bridge_link_codes k SET used_at = now() WHERE k.person_id = v_person AND k.account_id = p_account_id AND k.purpose = 'identity' AND k.used_at IS NULL;
  END IF;
  INSERT INTO app.bridge_link_codes (workspace_id, account_id, person_id, purpose, channel_id, code_hash, expires_at)
    VALUES (v_ws, p_account_id, v_person, p_purpose, CASE WHEN p_purpose = 'channel' THEN p_channel_id END, p_code_hash, v_expires);
  RETURN v_expires;
END
$$;

-- The accounts a member may link to ---------------------------------------------------------------------------------------------------------------
-- The Account page lists the chat apps that are on, with the handle people type. Nothing else of the account (counters, errors) is given.
CREATE FUNCTION app.bridges_available() RETURNS TABLE (account_id uuid, provider text, display_name text, handle text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF app.workspace_id() IS NULL OR app.person_id() IS NULL OR coalesce(app.lookup_workspace_role(), 'guest') = 'guest' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.id, a.provider, a.display_name, a.handle
    FROM app.bridge_accounts a
   WHERE a.workspace_id = app.workspace_id() AND a.status = 'on'
   ORDER BY a.provider;
END
$$;

-- Redeem an identity code (system) ---------------------------------------------------------------------------------------------------------------
-- The bridge calls this when a chat user sends a code. Answers the person's id when the code was good (right account, `identity`, unused, not expired), and then the chat
-- user is linked; answers NULL when it was not (the caller counts that toward the lockout). A chat user already linked to someone else is refused with an error, the code
-- stays unused.
CREATE FUNCTION app.bridges_link_identity(p_account_id uuid, p_code_hash text, p_external_user text, p_label text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  k        app.bridge_link_codes;
  v_other  uuid;
  v_active boolean;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the platform can redeem a code' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO k FROM app.bridge_link_codes
   WHERE code_hash = p_code_hash AND account_id = p_account_id AND purpose = 'identity' AND used_at IS NULL AND expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT (p.status = 'active' AND wm.role <> 'guest') INTO v_active
    FROM app.people p JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id
   WHERE p.id = k.person_id AND p.workspace_id = k.workspace_id;
  IF v_active IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  SELECT i.person_id INTO v_other FROM app.bridge_identities i WHERE i.account_id = p_account_id AND i.external_user_id = p_external_user;
  IF v_other IS NOT NULL AND v_other <> k.person_id THEN
    RAISE EXCEPTION 'This chat account is already linked to someone else' USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE app.bridge_link_codes SET used_at = now() WHERE id = k.id;
  -- a person who links again from another chat account replaces the old link
  DELETE FROM app.bridge_identities i WHERE i.account_id = p_account_id AND i.person_id = k.person_id AND i.external_user_id <> p_external_user;
  INSERT INTO app.bridge_identities (workspace_id, account_id, person_id, external_user_id, external_label)
    VALUES (k.workspace_id, p_account_id, k.person_id, p_external_user, left(p_label, 120))
    ON CONFLICT (account_id, external_user_id) DO UPDATE SET external_label = EXCLUDED.external_label, verified_at = now();
  RETURN k.person_id;
END
$$;

-- Redeem a channel code (system) ---------------------------------------------------------------------------------------------------------------
-- Typed by a lead in the outside chat. The person who asked is checked again now: still active, still a lead of the channel's team (or an admin), the channel still public and
-- live. Answers the link's id; NULL when the code was no good; an error when the chat already belongs to a channel.
CREATE FUNCTION app.bridges_link_channel(p_account_id uuid, p_code_hash text, p_external_chat text, p_label text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  k       app.bridge_link_codes;
  c       app.channels;
  v_ok    boolean;
  v_id    uuid;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the platform can redeem a code' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO k FROM app.bridge_link_codes
   WHERE code_hash = p_code_hash AND account_id = p_account_id AND purpose = 'channel' AND used_at IS NULL AND expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO c FROM app.channels WHERE id = k.channel_id;
  IF NOT FOUND OR c.private OR c.archived_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT (p.status = 'active' AND wm.role <> 'guest' AND (
            wm.role IN ('owner', 'admin')
            OR EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
                        WHERE tm.team_id = c.team_id AND a.ref_id = p.id AND tm.role = 'lead')))
    INTO v_ok
    FROM app.people p JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id
   WHERE p.id = k.person_id AND p.workspace_id = k.workspace_id;
  IF v_ok IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM app.bridge_links l WHERE l.account_id = p_account_id AND l.external_chat_id = p_external_chat) THEN
    RAISE EXCEPTION 'This chat is already joined to a channel' USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE app.bridge_link_codes SET used_at = now() WHERE id = k.id;
  INSERT INTO app.bridge_links (workspace_id, team_id, account_id, channel_id, external_chat_id, external_label, linked_by)
    VALUES (k.workspace_id, c.team_id, p_account_id, c.id, p_external_chat, left(p_label, 120), k.person_id)
    RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Row level security ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.bridge_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bridge_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_accounts_all ON app.bridge_accounts FOR ALL
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.bridge_accounts TO manythreads_app;

ALTER TABLE app.bridge_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bridge_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_secrets_system ON app.bridge_secrets FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

ALTER TABLE app.bridge_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bridge_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_identities_select ON app.bridge_identities FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (person_id = (SELECT app.person_id()) OR (SELECT app.workspace_role()) IN ('owner', 'admin')))
);
CREATE POLICY bridge_identities_insert ON app.bridge_identities FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY bridge_identities_update ON app.bridge_identities FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY bridge_identities_delete ON app.bridge_identities FOR DELETE USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND (person_id = (SELECT app.person_id()) OR (SELECT app.workspace_role()) IN ('owner', 'admin')))
);
GRANT SELECT, DELETE ON app.bridge_identities TO manythreads_app;

ALTER TABLE app.bridge_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bridge_link_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_link_codes_system ON app.bridge_link_codes FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

ALTER TABLE app.bridge_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bridge_links FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_links_select ON app.bridge_links FOR SELECT USING (
  (SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
);
CREATE POLICY bridge_links_insert ON app.bridge_links FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY bridge_links_update ON app.bridge_links FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY bridge_links_delete ON app.bridge_links FOR DELETE USING (
  (SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]))
);
GRANT SELECT, DELETE ON app.bridge_links TO manythreads_app;

ALTER TABLE app.bridge_dm_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bridge_dm_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_dm_sessions_select ON app.bridge_dm_sessions FOR SELECT USING (
  (SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND person_id = (SELECT app.person_id()))
);
CREATE POLICY bridge_dm_sessions_insert ON app.bridge_dm_sessions FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY bridge_dm_sessions_update ON app.bridge_dm_sessions FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY bridge_dm_sessions_delete ON app.bridge_dm_sessions FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.bridge_dm_sessions TO manythreads_app;

ALTER TABLE app.bridge_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bridge_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_messages_system ON app.bridge_messages FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

ALTER TABLE app.bridge_unlinked_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bridge_unlinked_chats FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_unlinked_chats_system ON app.bridge_unlinked_chats FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- Functions: owned by the system role like every other definer function ----------------------------------------------------------------------------
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.bridge_accounts_guard() OWNER TO manythreads_system;
ALTER FUNCTION app.bridge_links_guard() OWNER TO manythreads_system;
ALTER FUNCTION app.bridges_issue_code(uuid, text, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.bridges_available() OWNER TO manythreads_system;
ALTER FUNCTION app.bridges_link_identity(uuid, text, text, text) OWNER TO manythreads_system;
ALTER FUNCTION app.bridges_link_channel(uuid, text, text, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.bridge_accounts_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.bridge_links_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.bridges_issue_code(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.bridges_available() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.bridges_link_identity(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.bridges_link_channel(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bridges_issue_code(uuid, text, uuid, text) TO manythreads_app;
GRANT EXECUTE ON FUNCTION app.bridges_available() TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.bridges_link_identity(uuid, text, text, text) TO manythreads_system;
GRANT EXECUTE ON FUNCTION app.bridges_link_channel(uuid, text, text, text) TO manythreads_system;
