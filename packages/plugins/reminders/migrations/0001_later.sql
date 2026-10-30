-- reminders 0001: Later -- the messages a person saved to come back to, with an optional reminder time (PLAN.md P14-04). Forward-only: never edit once applied.
--
-- ONE ROW PER PERSON AND MESSAGE. (person_id, message_id) is unique: saving a message again changes its reminder, it does not add a row.
--
-- PRIVATE TO THE PERSON. A person reads, writes and removes only their own rows; nobody else does, an admin included. The system role (the job that
-- fires due reminders) reads and updates all of them. The row holds ids and times only, never any text of the message: the list route reads the
-- message under the caller's own access every time, so a deleted message, or a channel the person can no longer read, shows "no longer
-- available" and nothing else.
--
-- message_id has no foreign key on purpose: when a message is removed for good (retention) the item stays and says so, instead of vanishing
-- from the person's list. channel_id does (a deleted channel takes its items with it) and is what the insert policy checks: a person can only
-- save a message of a channel they can read.
--
-- A due reminder is a row with state 'open', remind_at in the past and fired_at null; the minute job sets fired_at in the same transaction that
-- writes the `reminders.reminder.due` event, so a reminder is announced once.

CREATE TABLE app.later_items (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  person_id      uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  message_id     uuid NOT NULL,
  channel_id     uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  thread_root_id uuid,
  state          text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done')),
  remind_at      timestamptz,
  fired_at       timestamptz,
  done_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'done') = (done_at IS NOT NULL))
);
CREATE UNIQUE INDEX later_items_person_message ON app.later_items (person_id, message_id);
CREATE INDEX later_items_person_state ON app.later_items (person_id, state, id DESC);
CREATE INDEX later_items_channel ON app.later_items (channel_id);
CREATE INDEX later_items_workspace ON app.later_items (workspace_id);
CREATE INDEX later_items_message ON app.later_items (message_id);
-- the job's whole working set
CREATE INDEX later_items_due ON app.later_items (remind_at) WHERE state = 'open' AND fired_at IS NULL AND remind_at IS NOT NULL;
COMMENT ON TABLE app.later_items IS 'rls: person — P: messages a person saved for later, with an optional reminder time; a person reads and changes only their own, the reminders job (system) fires the due ones. Ids and times only, never message text.';

-- A person changes an item only by marking it done or open and by moving its reminder; what it points at never changes.
CREATE FUNCTION app.later_items_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    IF (to_jsonb(NEW) - 'state' - 'done_at' - 'remind_at' - 'fired_at' - 'updated_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'done_at' - 'remind_at' - 'fired_at' - 'updated_at') THEN
      RAISE EXCEPTION 'a saved item changes only by its state and its reminder' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER later_items_guard BEFORE UPDATE ON app.later_items FOR EACH ROW EXECUTE FUNCTION app.later_items_guard();

-- At most 200 items per person, also when two requests race: the person's inserts take turns on an advisory lock (released at commit), and the
-- count sees only the person's own rows (row-level security).
CREATE FUNCTION app.later_items_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('later_items:' || NEW.person_id::text, 0));
  IF (SELECT count(*) FROM app.later_items WHERE person_id = NEW.person_id) >= 200 THEN
    RAISE EXCEPTION 'You already have 200 saved items. Finish or remove some first.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER later_items_cap BEFORE INSERT ON app.later_items FOR EACH ROW EXECUTE FUNCTION app.later_items_cap();

ALTER TABLE app.later_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.later_items FORCE ROW LEVEL SECURITY;
-- The job (system) reads and updates every row; the system role is not BYPASSRLS, so it needs a policy of its own.
CREATE POLICY later_items_system ON app.later_items FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY later_items_select ON app.later_items FOR SELECT
  USING (person_id = (SELECT app.person_id()));
CREATE POLICY later_items_insert ON app.later_items FOR INSERT WITH CHECK (
  person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())
  AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY later_items_update ON app.later_items FOR UPDATE
  USING (person_id = (SELECT app.person_id()))
  WITH CHECK (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()));
CREATE POLICY later_items_delete ON app.later_items FOR DELETE
  USING (person_id = (SELECT app.person_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON app.later_items TO manythreads_app;
