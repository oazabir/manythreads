-- channels 0016: a scheduled message remembers that its writer agreed to tell a big room (PLAN P14-02). Forward-only: never edit once applied.
--
-- `@channel` and `@here` in a room of more than 20 other readers need the writer's agreement (409 `broadcast_needs_confirmation` until `confirmBroadcast`).
-- A scheduled message is posted later by a job, with nobody to ask, so the agreement is given when the message is scheduled (or edited) and kept on the row;
-- the job posts it with that agreement. A message that was scheduled in a small room and found the room grown by its time is refused with the plain
-- sentence and can be edited (which asks again).

ALTER TABLE app.scheduled_messages ADD COLUMN broadcast_confirmed boolean NOT NULL DEFAULT false;

-- the same guard as 0013, with the new column among those a person's edit may change
CREATE OR REPLACE FUNCTION app.scheduled_messages_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    IF (to_jsonb(NEW) - 'body' - 'send_at' - 'state' - 'refused_reason' - 'refused_at' - 'attempts' - 'retry_at' - 'broadcast_confirmed' - 'updated_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'body' - 'send_at' - 'state' - 'refused_reason' - 'refused_at' - 'attempts' - 'retry_at' - 'broadcast_confirmed' - 'updated_at') THEN
      RAISE EXCEPTION 'a scheduled message changes only by its text and its time' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
