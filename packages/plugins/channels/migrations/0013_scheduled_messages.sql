-- channels 0013: scheduled send (PLAN P14-05). Forward-only: never edit once applied. (0012 belongs to another task.)
--
-- A scheduled message is text a person wrote now and chose a time for. A minute job (the channels plugin's `channels.send_scheduled` queue) posts
-- each due one AS THE AUTHOR through the same door a typed message uses, so it is checked again at that moment: the author must still be an active
-- member who may post in the channel, the channel must not be archived, a thread's first message must still be there. When any of that fails the
-- row is not lost: it becomes `refused` with the reason in plain words and stays the author's, to edit and reschedule or to dismiss.
--
-- A row exists only while the message is waiting (`scheduled`) or was refused (`refused`). A message that was sent, and one that was cancelled, are
-- deleted in the same transaction that posts or cancels them (the `channel.scheduled_message.changed` event keeps the record, without any text).
-- That one transaction is also what makes the send happen once: the job posts and deletes the row together under a row lock.
--
-- PRIVATE TO THE AUTHOR. Only the person who scheduled a message reads, edits or cancels it; nobody else does, a workspace admin included. A person
-- schedules only into a channel they may post in. The system role (the job; it marks a message refused) sees every row.
--
-- thread_root_id has no foreign key on purpose: if the thread's first message disappears the draft must survive and say so (the send is refused with
-- "That message was deleted"), not vanish with it. channel_id has one: a deleted channel takes its scheduled messages with it.

CREATE TABLE app.scheduled_messages (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  channel_id     uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  author_id      uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  thread_root_id uuid,
  -- the channel's team (null for a direct message), copied when the message is scheduled: the event of a cancel or a refusal names the team even when
  -- the author can no longer read the channel
  team_id        uuid,
  body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 40000),
  send_at        timestamptz NOT NULL,
  state          text NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled', 'refused')),
  refused_reason text CHECK (char_length(refused_reason) BETWEEN 1 AND 500),
  refused_at     timestamptz,
  -- sends that failed for a reason the person did not cause (a database error): after three the message is refused instead of retried for ever
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- a send the post door asked to try again later (HTTP 429 with retry-after): the job leaves the row alone until then; this does not count as an attempt
  retry_at       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'refused') = (refused_reason IS NOT NULL AND refused_at IS NOT NULL))
);
CREATE INDEX scheduled_messages_author ON app.scheduled_messages (author_id, channel_id, send_at);
CREATE INDEX scheduled_messages_channel ON app.scheduled_messages (channel_id);
CREATE INDEX scheduled_messages_workspace ON app.scheduled_messages (workspace_id);
-- the job's whole working set
CREATE INDEX scheduled_messages_due ON app.scheduled_messages (send_at, id) WHERE state = 'scheduled';
COMMENT ON TABLE app.scheduled_messages IS 'rls: person — P: messages a person scheduled to be posted later (state scheduled) and the ones that could not be posted (state refused, with the reason); only the author reads or changes a row, the send job (system) posts the due ones as the author.';

-- A person changes a row only through its text, its time, and the state those edits move (scheduling a refused message again). What it points at,
-- who wrote it and when never change (the team included).
CREATE FUNCTION app.scheduled_messages_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    IF (to_jsonb(NEW) - 'body' - 'send_at' - 'state' - 'refused_reason' - 'refused_at' - 'attempts' - 'retry_at' - 'updated_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'body' - 'send_at' - 'state' - 'refused_reason' - 'refused_at' - 'attempts' - 'retry_at' - 'updated_at') THEN
      RAISE EXCEPTION 'a scheduled message changes only by its text and its time' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER scheduled_messages_guard BEFORE UPDATE ON app.scheduled_messages FOR EACH ROW EXECUTE FUNCTION app.scheduled_messages_guard();

-- At most 100 per person, also when two requests race: the person's inserts take turns on an advisory lock (released at commit), and the count sees
-- only the author's own rows (row-level security).
CREATE FUNCTION app.scheduled_messages_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('scheduled_messages:' || NEW.author_id::text, 0));
  IF (SELECT count(*) FROM app.scheduled_messages WHERE author_id = NEW.author_id) >= 100 THEN
    RAISE EXCEPTION 'You already have 100 scheduled messages. Send or cancel some first.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER scheduled_messages_cap BEFORE INSERT ON app.scheduled_messages FOR EACH ROW EXECUTE FUNCTION app.scheduled_messages_cap();

ALTER TABLE app.scheduled_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scheduled_messages FORCE ROW LEVEL SECURITY;
-- The job (system) reads and updates every row; the system role is not BYPASSRLS, so it needs a policy of its own.
CREATE POLICY scheduled_messages_system ON app.scheduled_messages FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY scheduled_messages_select ON app.scheduled_messages FOR SELECT
  USING (author_id = (SELECT app.actor()));
-- a person (not a bot) schedules as themself, in their own workspace, into a channel they may post in, and only a message that is waiting
CREATE POLICY scheduled_messages_insert ON app.scheduled_messages FOR INSERT WITH CHECK (
  author_id = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL
  AND workspace_id = (SELECT app.workspace_id()) AND state = 'scheduled'
  AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]));
-- an edit leaves the message waiting (a refused one is scheduled again); it never marks one refused: only the system does that
CREATE POLICY scheduled_messages_update ON app.scheduled_messages FOR UPDATE
  USING (author_id = (SELECT app.actor()))
  WITH CHECK (author_id = (SELECT app.actor()) AND workspace_id = (SELECT app.workspace_id()) AND state = 'scheduled');
CREATE POLICY scheduled_messages_delete ON app.scheduled_messages FOR DELETE
  USING (author_id = (SELECT app.actor()));

GRANT SELECT, INSERT, UPDATE, DELETE ON app.scheduled_messages TO manythreads_app;
