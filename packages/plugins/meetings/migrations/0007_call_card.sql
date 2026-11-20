-- meetings 0007: the call card (PLAN P15-26, docs/plans/calls-card.md step S1). Forward-only: never edit once applied.
--
-- A call's start message (the channel message a call posts when it opens, root of the call's chat thread) now carries a stamp in its `meta`: exactly
-- `{"meeting": {"meetingId": "<uuid>"}}`. A stamp is a key in `meta` only the platform may set. The web draws the call card from it; the card's title, state and counts
-- come from `GET /api/meetings/cards`, so the message itself never changes with the call. Four parts:
--
--   1. `meetings.kind`: `audio` or `video`. Video is refused by the start route (409) until video calls exist (P17-01); the 0001 guard keeps it fixed after the insert.
--   2. The stamp is checked by the database, whoever inserts the message: the meeting is live, in the same channel, started by the message's author, has no start message
--      yet, and the message is top-level. Otherwise 42501. The trigger runs as the caller (not a definer function: inside a definer function owned by the system role
--      `app.is_system()` is always true), and only for a message whose `meta` has the key. One card per call is a unique index.
--   3. `meetings.thread_root_id` may be set by a caller only from nothing to the message stamped with this meeting. Going back to nothing stays allowed: that is the
--      `ON DELETE SET NULL` of the foreign key, which runs as the table owner.
--   4. The start messages written before this file get the stamp (only real ones: the starter's own top-level "Started a voice room:" message in the call's channel).

-- 1. the kind of call --------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE app.meetings ADD COLUMN kind text NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio', 'video'));
COMMENT ON COLUMN app.meetings.kind IS 'audio or video; set when the call starts and never changed (the meetings_guard trigger). Video is refused by the start route until P17-01.';

-- 2. the stamp on the start message ------------------------------------------------------------------------------------------------------------------------
-- Not SECURITY DEFINER on purpose (review correction 1): the caller reads its own channel's meeting through the row policies, and `app.is_system()` means what it says.
-- Variables are `record`, not `app.meetings%ROWTYPE` (MISTAKES P15-13).
CREATE FUNCTION app.messages_meeting_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_stamp jsonb := NEW.meta -> 'meeting';
  m record;
BEGIN
  IF jsonb_typeof(v_stamp) IS DISTINCT FROM 'object' OR (v_stamp - 'meetingId') <> '{}'::jsonb
     OR jsonb_typeof(v_stamp -> 'meetingId') IS DISTINCT FROM 'string'
     OR (v_stamp ->> 'meetingId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'meta.meeting is {"meetingId": "<uuid>"} and nothing else' USING ERRCODE = 'check_violation';
  END IF;
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  SELECT x.id, x.channel_id, x.started_by, x.state, x.thread_root_id INTO m FROM app.meetings x WHERE x.id = (v_stamp ->> 'meetingId')::uuid;
  IF NOT FOUND OR m.channel_id IS DISTINCT FROM NEW.channel_id OR m.started_by IS DISTINCT FROM NEW.author_id OR m.state <> 'live'
     OR m.thread_root_id IS NOT NULL OR NEW.thread_root_id IS NOT NULL THEN
    RAISE EXCEPTION 'only a call''s own start message carries its card' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
-- fires after messages_before_insert (triggers of one event run in name order); ordinary posts never run it
CREATE TRIGGER messages_meeting_stamp BEFORE INSERT ON app.messages FOR EACH ROW
  WHEN (NEW.meta ? 'meeting') EXECUTE FUNCTION app.messages_meeting_stamp();

-- One card per call. Built without CONCURRENTLY (a migration runs in a transaction): it holds writes on app.messages while it builds, fine at the current size.
-- compared as a uuid, so an upper-case spelling of the same id is the same call (the trigger has already refused a value that is not a uuid)
CREATE UNIQUE INDEX messages_meeting_card ON app.messages (((meta -> 'meeting' ->> 'meetingId')::uuid)) WHERE meta ? 'meeting';

-- 3. the guard: the call thread's root is the call's own stamped message ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.meetings_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    IF (to_jsonb(NEW) - 'thread_root_id') IS DISTINCT FROM (to_jsonb(OLD) - 'thread_root_id') THEN
      RAISE EXCEPTION 'a voice room changes only through its own functions' USING ERRCODE = 'check_violation';
    END IF;
    -- to nothing is the foreign key's ON DELETE SET NULL (review correction 2); from nothing only to the message stamped with this meeting
    IF NEW.thread_root_id IS NOT NULL AND NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id THEN
      IF OLD.thread_root_id IS NOT NULL
         OR NOT EXISTS (SELECT 1 FROM app.messages x WHERE x.id = NEW.thread_root_id AND x.meta -> 'meeting' ->> 'meetingId' = NEW.id::text) THEN
        RAISE EXCEPTION 'a call''s thread starts at its own start message' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;
  IF OLD.state = 'ended' AND (NEW.state <> 'ended' OR NEW.ended_at IS DISTINCT FROM OLD.ended_at) THEN
    RAISE EXCEPTION 'this voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 4. the start messages written before this file -----------------------------------------------------------------------------------------------------------
-- Only real start messages (review correction 3): the old guard let a caller point thread_root_id at any message. A `meta`-only update records no version, event or
-- push (the AFTER UPDATE triggers of messages fire on body, body_plain and deleted_at only). The system role writes the rows (the migrating role is not in the row
-- policies); a test seeds legacy rows and runs this block. Two meetings pointing at one message (the old guard allowed it) stamp it once, for the earlier
-- meeting, so the unique index above holds.
-- legacy-begin
SET ROLE manythreads_system;
UPDATE app.messages msg
   SET meta = msg.meta || jsonb_build_object('meeting', jsonb_build_object('meetingId', m.id::text))
  -- the real-start-message checks run before DISTINCT ON picks a meeting, so a meeting that only pointed at another call's start message never wins over its own
  FROM (SELECT DISTINCT ON (x.thread_root_id) x.id, x.thread_root_id
          FROM app.meetings x JOIN app.messages s ON s.id = x.thread_root_id
         WHERE s.author_id = x.started_by
           AND s.channel_id = x.channel_id
           AND s.thread_root_id IS NULL
           AND s.body LIKE 'Started a voice room:%'
           AND NOT (s.meta ? 'meeting')
         ORDER BY x.thread_root_id, x.started_at, x.id) m
 WHERE msg.id = m.thread_root_id;
RESET ROLE;
-- legacy-end
