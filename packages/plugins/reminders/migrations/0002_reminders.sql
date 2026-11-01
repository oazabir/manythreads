-- reminders 0002: /remind (PLAN.md P14-04). Forward-only: never edit once applied.
--
-- A REMINDER is text a person asked to be told, at a time: for themself (`me`), for another person who can read the place it was asked in (`person`),
-- or for a channel (`channel`, a message posted there). The row holds the text and the time and nothing else of the world; a minute job (reminders
-- plugin, send.ts) delivers each due one, after checking the rights again at that moment:
--   me       the text is posted as the "Reminders" sender into the person's own Reminders conversation (a direct message with only that person in it),
--            and the person gets a notification.
--   person   the same, into the other person's Reminders conversation, after checking that the maker can still read the place and the person still can.
--   channel  the text is posted as the "Reminders" sender into the channel, after checking that the maker can still post there.
--
-- PRIVATE TO THE MAKER. A person reads, creates and cancels only their own rows; nobody else reads a row, an admin included, and the person a reminder
-- is for never reads it (they get the posted message, which is theirs). A person can only cancel (state 'pending' -> 'cancelled'); sending, refusing
-- and removing are the system role's (the job). The row's channel must be one the maker can read (`me`/`person`) or post in (`channel`) when it is made.
--
-- THE SENDER. Each workspace has one actor of kind 'system' that authors the delivered messages, recorded in app.reminder_senders and made on first use
-- by app.reminders_act_as(), which also switches the transaction's actor to it (as app.webhooks_act_as does for a webhook). Only the system role may
-- call it. app.message_authors names that actor "Reminders" (this migration replaces it, on top of webhooks 0002: the plugin therefore depends on
-- `webhooks`, which depends on `bots`, so the order of the migrations is right).
--
-- THE REMINDERS CONVERSATION. A person's Reminders conversation is a direct message channel (kind 'dm', private, no team) with the person as its only
-- member and the key 'reminders:<person id>', made on first use by app.reminders_inbox(). The channels plugin's own door for DMs (app.dms_get_or_create)
-- is for people and never makes this one.
--
-- message_id of the delivered message has no foreign key on purpose: when a message is removed for good (retention) the history row stays.

CREATE TABLE app.reminders (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  creator_id       uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  target_kind      text NOT NULL CHECK (target_kind IN ('me', 'person', 'channel')),
  target_person_id uuid REFERENCES app.people (id) ON DELETE CASCADE,
  -- `person`: the conversation the reminder was asked in (both people must read it); `channel`: where it is posted; `me`: none
  channel_id       uuid REFERENCES app.channels (id) ON DELETE CASCADE,
  text             text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500 AND position(chr(10) IN text) = 0 AND position(chr(13) IN text) = 0),
  remind_at        timestamptz NOT NULL,
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'cancelled', 'refused')),
  refused_reason   text CHECK (char_length(refused_reason) BETWEEN 1 AND 500),
  sent_message_id  uuid,
  sent_at          timestamptz,
  -- deliveries that failed for a reason that was not the maker's (a database error): after three the reminder is refused instead of tried for ever
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_kind = 'person') = (target_person_id IS NOT NULL)),
  CHECK ((target_kind = 'me') = (channel_id IS NULL)),
  CHECK ((state = 'refused') = (refused_reason IS NOT NULL)),
  CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
  CHECK (remind_at <= created_at + interval '366 days')
);
CREATE INDEX reminders_creator ON app.reminders (creator_id, state, remind_at);
CREATE INDEX reminders_channel ON app.reminders (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX reminders_target ON app.reminders (target_person_id) WHERE target_person_id IS NOT NULL;
CREATE INDEX reminders_workspace ON app.reminders (workspace_id);
-- the job's whole working set
CREATE INDEX reminders_due ON app.reminders (remind_at, id) WHERE state = 'pending';
COMMENT ON TABLE app.reminders IS 'rls: person — P: reminders a person asked for with /remind (for themself, another person or a channel); only the maker reads a row and may cancel it, the reminders job (system) delivers, refuses and removes them. Text and time only.';

CREATE TABLE app.reminder_senders (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces (id) ON DELETE CASCADE,
  actor_id     uuid NOT NULL UNIQUE REFERENCES app.actors (id) ON DELETE CASCADE
);
COMMENT ON TABLE app.reminder_senders IS 'rls: system — S: the system actor that authors a workspace''s delivered reminders (named "Reminders" by app.message_authors); made by app.reminders_act_as only.';

-- A person changes a row only by cancelling it; everything else belongs to the job.
CREATE FUNCTION app.reminders_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    IF OLD.state <> 'pending' OR NEW.state <> 'cancelled'
       OR (to_jsonb(NEW) - 'state' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'updated_at') THEN
      RAISE EXCEPTION 'a reminder can only be cancelled' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reminders_guard BEFORE UPDATE ON app.reminders FOR EACH ROW EXECUTE FUNCTION app.reminders_guard();

-- Can this person be told about this conversation: an active member of the workspace, not a guest, who reads the channel? The caller must read the
-- channel too (a person cannot probe who reads a channel they cannot see); a stranger or an unreadable channel answers false.
CREATE FUNCTION app.reminders_target_ok(p_person_id uuid, p_channel_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT coalesce((
    SELECT true
      FROM app.channel_audience(p_channel_id) a
      JOIN app.workspace_members wm ON wm.person_id = a.person_id AND wm.workspace_id = app.workspace_id()
     WHERE a.person_id = p_person_id AND wm.role <> 'guest'
     LIMIT 1), false)
$$;

-- How many reminders wait for a person, from ALL makers. Row-level security shows a maker only their own rows, so the count is a definer function (owned
-- by the system role, whose policy sees every row); it returns a number and nothing else. Used to cap what one person can be sent, whoever sends it.
CREATE FUNCTION app.reminders_pending_for(p_person_id uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT coalesce((SELECT count(*)::integer FROM app.reminders
                    WHERE target_kind = 'person' AND target_person_id = p_person_id AND state = 'pending' AND workspace_id = app.workspace_id()), 0)
$$;

-- The maker's budget and the target's right, at the moment the row is made. The maker's inserts take turns on an advisory lock (released at commit), and
-- the counts see only the maker's own rows (row-level security), so two requests racing cannot both slip under a limit.
CREATE FUNCTION app.reminders_before_insert() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_role text := app.lookup_workspace_role();
BEGIN
  -- the system role makes no reminders of its own (the budget is a person's); fixtures written by it are not counted
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF v_role IS NULL OR v_role = 'guest' THEN
    RAISE EXCEPTION 'Reminders are for members of the workspace.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.target_kind = 'person' THEN
    IF NEW.target_person_id = NEW.creator_id THEN
      RAISE EXCEPTION 'To remind yourself, write /remind me.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app.reminders_target_ok(NEW.target_person_id, NEW.channel_id) THEN
      RAISE EXCEPTION 'That person cannot read this conversation, so they cannot be reminded about it here.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.target_kind = 'person' THEN
    -- the maker's lock and the recipient's, always in the same (sorted) order, so two people reminding each other cannot wait for each other for ever
    PERFORM pg_advisory_xact_lock(hashtextextended('reminders:' || least(NEW.creator_id::text, NEW.target_person_id::text), 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('reminders:' || greatest(NEW.creator_id::text, NEW.target_person_id::text), 0));
    IF app.reminders_pending_for(NEW.target_person_id) >= 20 THEN
      RAISE EXCEPTION 'That person already has many reminders waiting. Try again later.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('reminders:' || NEW.creator_id::text, 0));
  END IF;
  IF (SELECT count(*) FROM app.reminders WHERE creator_id = NEW.creator_id AND state = 'pending') >= 100 THEN
    RAISE EXCEPTION 'You already have 100 reminders waiting. Cancel some first.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.target_kind <> 'me' THEN
    IF (SELECT count(*) FROM app.reminders WHERE creator_id = NEW.creator_id AND state = 'pending' AND target_kind <> 'me') >= 20 THEN
      RAISE EXCEPTION 'You already have 20 reminders waiting for other people or channels. Cancel some first.' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(*) FROM app.reminders WHERE creator_id = NEW.creator_id AND target_kind <> 'me' AND created_at > now() - interval '1 hour') >= 30 THEN
      RAISE EXCEPTION 'You have set many reminders for other people in the last hour. Try again later.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.target_kind = 'person'
       AND (SELECT count(*) FROM app.reminders WHERE creator_id = NEW.creator_id AND state = 'pending' AND target_person_id = NEW.target_person_id) >= 10 THEN
      RAISE EXCEPTION 'You already have 10 reminders waiting for that person.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reminders_before_insert BEFORE INSERT ON app.reminders FOR EACH ROW EXECUTE FUNCTION app.reminders_before_insert();

ALTER TABLE app.reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reminders FORCE ROW LEVEL SECURITY;
-- The job (system) reads, updates and removes every row; the system role is not BYPASSRLS, so it needs a policy of its own.
CREATE POLICY reminders_system ON app.reminders FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY reminders_select ON app.reminders FOR SELECT
  USING (creator_id = (SELECT app.person_id()));
-- a person (not a bot) makes a waiting reminder as themself, in their own workspace; the place must be one they read (for themself or another
-- person) or may post in (for a channel)
CREATE POLICY reminders_insert ON app.reminders FOR INSERT WITH CHECK (
  creator_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()) AND state = 'pending'
  AND (target_kind = 'me'
       OR (target_kind = 'person' AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]))
       OR (target_kind = 'channel' AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]))));
-- cancelling: a waiting row becomes cancelled (the guard allows nothing else)
CREATE POLICY reminders_update ON app.reminders FOR UPDATE
  USING (creator_id = (SELECT app.person_id()) AND state = 'pending')
  WITH CHECK (creator_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()) AND state = 'cancelled');

ALTER TABLE app.reminder_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reminder_senders FORCE ROW LEVEL SECURITY;
CREATE POLICY reminder_senders_system ON app.reminder_senders FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

GRANT SELECT, INSERT, UPDATE ON app.reminders TO manythreads_app;

-- Act as the Reminders sender: the one thing the job needs the system role to do. Makes the workspace's sender on first use, then switches the
-- transaction's actor to it for the rest of the transaction. Only the system role may call it, in a transaction scoped to a workspace.
CREATE FUNCTION app.reminders_act_as() RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws    uuid := app.workspace_id();
  v_actor uuid;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the system role acts as the reminders sender' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'no workspace' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT s.actor_id INTO v_actor FROM app.reminder_senders s WHERE s.workspace_id = v_ws;
  IF v_actor IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('reminder_senders:' || v_ws::text, 0));
    SELECT s.actor_id INTO v_actor FROM app.reminder_senders s WHERE s.workspace_id = v_ws;
    IF v_actor IS NULL THEN
      INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('system', v_ws, v_ws) RETURNING id INTO v_actor;
      INSERT INTO app.reminder_senders (workspace_id, actor_id) VALUES (v_ws, v_actor);
    END IF;
  END IF;
  PERFORM set_config('app.actor_id', v_actor::text, true);
  RETURN v_actor;
END
$$;

-- A person's Reminders conversation, made on first use. The person must be an active member of the workspace, not a guest (a guest's reach is the
-- channels they were granted). Call app.reminders_act_as() first: the conversation is made by the sender. One statement, like app.dms_get_or_create.
CREATE FUNCTION app.reminders_inbox(p_person_id uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ws      uuid := app.workspace_id();
  v_actor   uuid;
  v_new     uuid := uuidv7();
  v_channel uuid;
BEGIN
  IF session_user <> 'manythreads_system' THEN
    RAISE EXCEPTION 'only the system role makes a Reminders conversation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.actor_id INTO v_actor FROM app.reminder_senders s WHERE s.workspace_id = v_ws;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'act as the reminders sender first' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.people p JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id
                  WHERE p.id = p_person_id AND p.workspace_id = v_ws AND p.status = 'active' AND wm.role <> 'guest') THEN
    RAISE EXCEPTION 'reminders are for active members of the workspace' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH ch AS (
    INSERT INTO app.channels AS c (id, workspace_id, team_id, name, kind, private, dm_key, created_by)
    VALUES (v_new, v_ws, NULL, '', 'dm', true, 'reminders:' || p_person_id::text, v_actor)
    ON CONFLICT (workspace_id, dm_key) WHERE kind = 'dm' DO SELECT
    RETURNING c.id
  ), members AS (
    INSERT INTO app.channel_members (channel_id, person_id)
    SELECT ch.id, p_person_id FROM ch
    ON CONFLICT DO NOTHING
  )
  SELECT ch.id INTO v_channel FROM ch;
  RETURN v_channel;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.reminders_target_ok(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.reminders_pending_for(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.reminders_act_as() OWNER TO manythreads_system;
ALTER FUNCTION app.reminders_inbox(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.reminders_target_ok(uuid, uuid), app.reminders_pending_for(uuid), app.reminders_act_as(), app.reminders_inbox(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reminders_target_ok(uuid, uuid), app.reminders_pending_for(uuid) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.reminders_act_as(), app.reminders_inbox(uuid) TO manythreads_system;

-- Naming the author: webhooks 0002's body plus "the Reminders sender is named Reminders". The owner and the grants are unchanged (CREATE OR REPLACE keeps
-- both). A webhook's own name still comes first, so a database that has the sender but no webhook row names it as before.
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
  IF session_user = 'manythreads_system' THEN
    -- the system role has no person to read as: when a webhook or the reminders job posts, the message path runs as it and names the author of the
    -- message it pushes live; the messages asked for are the ones it just wrote, so every channel is in view
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
                         'System')
         END,
         a.kind
    FROM (SELECT DISTINCT m.author_id
            FROM app.messages m
           WHERE m.id = ANY (p_message_ids[1:500]) AND m.channel_id = ANY (v_visible)) x
    JOIN app.actors a ON a.id = x.author_id AND a.workspace_id = app.workspace_id()
    LEFT JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id AND p.workspace_id = a.workspace_id
    LEFT JOIN app.bots b ON a.kind = 'bot' AND b.id = a.ref_id AND b.workspace_id = a.workspace_id
    LEFT JOIN app.webhooks w ON a.kind = 'system' AND w.actor_id = a.id AND w.workspace_id = a.workspace_id
    LEFT JOIN app.reminder_senders rs ON a.kind = 'system' AND rs.actor_id = a.id AND rs.workspace_id = a.workspace_id;
END
$$;
