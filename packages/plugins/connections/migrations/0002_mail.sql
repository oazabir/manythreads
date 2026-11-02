-- connections 0002: the mailbox of a mail connection and the claims of the `inbox` trigger (PLAN P8-29, P8-30). Forward-only: never edit once applied.
--
--   connection_messages     the dummy mail transport's mailbox: every mail that arrived (`in`), was sent through the connection (`out`) or was saved and not sent
--                           (`draft`). A real transport keeps its mail elsewhere; the table stays the platform's own record of what it did, and the dummy's mailbox.
--   connection_mail_claims  one row per bot per mail thread: the bot's `inbox` trigger saw the first mail of the thread and the runtime opened ONE run for it. The row
--                           also remembers the bot's post about the thread (`root_message_id`), which is how a later run in that thread finds the mail it answers.
--
-- A mail is text other people wrote. It is stored as it came and returned only to the people of the team; no event, audit row or log line repeats it.
--
-- No foreign keys to the bots or channels plugins (this plugin's own tests migrate without them): `bot_id`, `run_id` and `root_message_id` are plain ids. A lookup joins the
-- other plugin's table, so a stale id finds nothing and cannot widen anything; `dropBot` removes a bot's claims when the bot goes.

-- connection_messages (T) -------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.connection_messages (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  -- the order mails arrived in; what a poll's cursor reads (a uuidv7 is ordered too, but not within one millisecond)
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('in', 'out', 'draft')),
  folder        text NOT NULL DEFAULT 'INBOX' CHECK (btrim(folder) <> '' AND char_length(folder) <= 100),
  -- the mail thread: the first mail's own id, or the thread of the mail it answers
  thread_key    text NOT NULL CHECK (char_length(thread_key) BETWEEN 1 AND 300),
  -- this mail's own id (`Message-ID`); the same id twice on one connection and direction is one mail
  message_id    text NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 300),
  in_reply_to   text CHECK (in_reply_to IS NULL OR char_length(in_reply_to) BETWEEN 1 AND 300),
  from_address  text NOT NULL CHECK (char_length(from_address) BETWEEN 1 AND 320),
  to_address    text NOT NULL CHECK (char_length(to_address) BETWEEN 1 AND 320),
  subject       text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 300),
  -- bounded by the table, not only by the code that writes it
  body          text NOT NULL DEFAULT '' CHECK (char_length(body) <= 100000),
  -- when it arrived or was written
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- the mail can only name a connection of its own team
  FOREIGN KEY (connection_id, team_id) REFERENCES app.connections (id, team_id) ON DELETE CASCADE,
  UNIQUE (connection_id, direction, message_id)
);
CREATE INDEX connection_messages_poll ON app.connection_messages (connection_id, direction, seq DESC);
CREATE INDEX connection_messages_thread ON app.connection_messages (connection_id, thread_key);
CREATE INDEX connection_messages_team ON app.connection_messages (team_id);
CREATE INDEX connection_messages_workspace ON app.connection_messages (workspace_id);
CREATE INDEX connection_messages_created_brin ON app.connection_messages USING brin (created_at);
COMMENT ON TABLE app.connection_messages IS 'rls: team — T: readable by the people of the connection''s team (never a guest). A workspace admin may add an `in` mail (the dummy transport''s delivery door); `out` and `draft` rows are written only by app.connection_mail_put_outbound, and everything else by the system. Mail is immutable once stored.';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id ON app.connection_messages
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- connection_mail_claims (T) -----------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.connection_mail_claims (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  connection_id   uuid NOT NULL,
  -- the bot whose `inbox` trigger claimed the thread (an id of the bots plugin; no foreign key, see the header)
  bot_id          uuid NOT NULL,
  thread_key      text NOT NULL CHECK (char_length(thread_key) BETWEEN 1 AND 300),
  -- the mail that opened the thread: the sender of THIS mail is who a reply goes to, whatever arrives later in the thread
  mail_id         uuid NOT NULL REFERENCES app.connection_messages (id) ON DELETE CASCADE,
  -- the run that answered the claim and the post it made, written when that post is seen (channel.message.posted with meta.runId)
  run_id          uuid,
  root_message_id uuid,
  linked_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, team_id) REFERENCES app.connections (id, team_id) ON DELETE CASCADE,
  -- one run per bot per mail thread: a second claim on the same thread cannot be written
  UNIQUE (connection_id, bot_id, thread_key),
  CONSTRAINT connection_mail_claims_linked CHECK ((run_id IS NULL) = (root_message_id IS NULL) AND (root_message_id IS NULL) = (linked_at IS NULL))
);
-- a thread of the channel belongs to one claim, and so does a run
CREATE UNIQUE INDEX connection_mail_claims_root ON app.connection_mail_claims (root_message_id) WHERE root_message_id IS NOT NULL;
CREATE UNIQUE INDEX connection_mail_claims_run ON app.connection_mail_claims (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX connection_mail_claims_mail ON app.connection_mail_claims (mail_id);
CREATE INDEX connection_mail_claims_bot ON app.connection_mail_claims (bot_id);
CREATE INDEX connection_mail_claims_team ON app.connection_mail_claims (team_id);
CREATE INDEX connection_mail_claims_workspace ON app.connection_mail_claims (workspace_id);
COMMENT ON TABLE app.connection_mail_claims IS 'rls: team — T: readable by the people of the team (never a guest); written by the system only (the inbox watch and the link to the bot''s post).';
CREATE TRIGGER workspace_refs_guard BEFORE INSERT OR UPDATE OF workspace_id, team_id ON app.connection_mail_claims
  FOR EACH ROW EXECUTE FUNCTION app.workspace_refs_guard();

-- The one writer of `out` and `draft` mail ---------------------------------------------------------------------------------------------------------
-- A bot's `email.send` and `email.draft` write the mailbox through this function and nothing else. SECURITY DEFINER (owned by the system role) because the application role
-- may not insert `out` or `draft` rows at all; the search_path is pinned. It checks, with the caller's own actor, what the code above it also checks:
--   * the caller holds the grant for the tool on THIS connection (a bot with no grant writes nothing, whatever it calls);
--   * a SEND answers a mail: it needs the inbound mail it replies to, and the recipient is that mail's sender, read here from the stored row. The `p_to` argument is
--     ignored whenever a mail is replied to, so no string a caller passes can become the address a send goes to. A draft with no mail to answer takes `p_to`: a draft is
--     not sent, and nothing in the platform sends a draft.
-- Inside a definer function app.is_system() is always true, so the caller is read from the actor and the workspace the session was opened with.
CREATE FUNCTION app.connection_mail_put_outbound(
  p_connection uuid, p_tool text, p_reply_to uuid, p_to text, p_subject text, p_body text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor     uuid := app.actor();
  v_workspace uuid := app.workspace_id();
  v_conn      record;
  v_orig      record;
  v_to        text;
  v_thread    text;
  v_in_reply  text;
  v_ref       text := '<' || uuidv7()::text || '@mail.manythreads.invalid>';
  v_id        uuid;
BEGIN
  IF p_tool NOT IN ('email.send', 'email.draft') THEN
    RAISE EXCEPTION 'connection_mail_put_outbound writes email.send and email.draft only' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.id, c.team_id, c.workspace_id, c.slug INTO v_conn
    FROM app.connection_grants g
    JOIN app.connections c ON c.id = g.connection_id AND c.team_id = g.team_id
   WHERE g.actor_id = v_actor AND g.connection_id = p_connection AND g.tool = p_tool AND c.scope = 'team' AND c.kind = 'email'
     AND g.workspace_id = v_workspace AND c.workspace_id = v_workspace;
  IF v_conn.id IS NULL THEN
    RAISE EXCEPTION 'no grant for % on this connection', p_tool USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_reply_to IS NOT NULL THEN
    SELECT m.from_address, m.thread_key, m.message_id INTO v_orig
      FROM app.connection_messages m
     WHERE m.id = p_reply_to AND m.connection_id = p_connection AND m.direction = 'in';
    IF v_orig.thread_key IS NULL THEN
      RAISE EXCEPTION 'the mail to answer is not in this mailbox' USING ERRCODE = 'no_data_found';
    END IF;
    v_to := v_orig.from_address;
    v_thread := v_orig.thread_key;
    v_in_reply := v_orig.message_id;
  ELSIF p_tool = 'email.send' THEN
    RAISE EXCEPTION 'a send answers a mail; there is none to answer' USING ERRCODE = 'check_violation';
  ELSE
    IF p_to IS NULL OR btrim(p_to) = '' THEN
      RAISE EXCEPTION 'a draft that answers no mail needs an address' USING ERRCODE = 'check_violation';
    END IF;
    v_to := p_to;
    v_thread := v_ref;
  END IF;

  INSERT INTO app.connection_messages (workspace_id, team_id, connection_id, direction, folder, thread_key, message_id, in_reply_to, from_address, to_address, subject, body)
  VALUES (v_conn.workspace_id, v_conn.team_id, v_conn.id, CASE WHEN p_tool = 'email.send' THEN 'out' ELSE 'draft' END,
          CASE WHEN p_tool = 'email.send' THEN 'Sent' ELSE 'Drafts' END,
          v_thread, v_ref, v_in_reply, v_conn.slug || '@mail.manythreads.invalid', v_to, p_subject, p_body)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION app.connection_mail_put_outbound(uuid, text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.connection_mail_put_outbound(uuid, text, uuid, text, text, text) TO manythreads_app;

-- Row level security -------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.connection_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_messages_select ON app.connection_messages FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
-- the delivery door: a workspace admin of this workspace adds an INBOUND mail; every other row is written by the definer function above or by the system
CREATE POLICY connection_messages_insert ON app.connection_messages FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (direction = 'in' AND workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin'))
);
CREATE POLICY connection_messages_update ON app.connection_messages FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY connection_messages_delete ON app.connection_messages FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT ON app.connection_messages TO manythreads_app;

ALTER TABLE app.connection_mail_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_mail_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_mail_claims_select ON app.connection_mail_claims FOR SELECT USING (
  (SELECT app.is_system()) OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY connection_mail_claims_insert ON app.connection_mail_claims FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY connection_mail_claims_update ON app.connection_mail_claims FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY connection_mail_claims_delete ON app.connection_mail_claims FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.connection_mail_claims TO manythreads_app;

-- Owned by the system role like every other definer function.
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.connection_mail_put_outbound(uuid, text, uuid, text, text, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
