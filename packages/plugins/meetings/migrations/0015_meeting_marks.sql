-- meetings 0015: Mark action item and the end-of-call review (PLAN P17-06 step 2, docs/plans/meeting-assistant.md). Forward-only: never edit once applied.
--
-- In a live call a person presses "Mark action item": the plugin takes the final transcript lines of the last 30 seconds (the words of people who said yes to being
-- transcribed only) and keeps them as a MARK. When the call has ended, the notes' action items and the marks open a REVIEW for the people who were in the call: they change
-- an item's words or owner, remove one, and one of them confirms. Only confirmed items go into the notes' list of action items.
--
--   meeting_marks     read by the readers of the call's channel (the same people who could read the lines it took); written by a person in the live call, as
--                     themself, at most 30 per person and call. Never changed; removed with the call, and removed when one of the people (or link guests) whose
--                     words it holds says no to being transcribed (app.meetings_set_consent and the guest's consent route), as their lines are blanked.
--   meeting_reviews   one row per call, made by the platform. Read by the people who were in the call while they can still read its channel; confirmed once by one of
--                     them (the guard keeps everything else, and checks that every confirmed item is an item of the review). The platform may open it again when the
--                     notes arrive after it was confirmed.
--   app.meetings_set_consent   (replaced from 0002) a no also removes the marks that hold the caller's words.

-- Marks ----------------------------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.meeting_marks (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id   uuid NOT NULL REFERENCES app.meetings (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- copied from the call by the insert trigger (the policies read them)
  channel_id   uuid,
  team_id      uuid,
  marked_by    uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  at_ms        integer NOT NULL CHECK (at_ms >= 0),
  text         text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
  -- whose words the text holds: the people (actor ids) and the link guests (meeting_guests ids); a no from any of them removes the mark
  speaker_ids  uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(speaker_ids) <= 100),
  guest_ids    uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(guest_ids) <= 100),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_marks_meeting ON app.meeting_marks (meeting_id, created_at);
CREATE INDEX meeting_marks_marked_by ON app.meeting_marks (marked_by);
CREATE INDEX meeting_marks_workspace ON app.meeting_marks (workspace_id);
CREATE INDEX meeting_marks_speakers ON app.meeting_marks USING gin (speaker_ids);
CREATE INDEX meeting_marks_guests ON app.meeting_marks USING gin (guest_ids);
COMMENT ON TABLE app.meeting_marks IS 'rls: team — C: "Mark action item" in a live call (P17-06): the final lines of the last 30 seconds, kept for the end-of-call review; read by the readers of the call''s channel, written by a person in the live call as themself (at most 30 each), never changed.';

-- Every speaker a mark names said yes, now: their rows are locked (FOR SHARE) first, so a "no" that commits while the mark is written either comes first (the mark
-- is refused) or waits for it (and then removes it). Definer, owned by the system role (the rows of other people and of guests are read).
CREATE FUNCTION app.meeting_marks_speakers_said_yes(p_meeting_id uuid, p_speaker_ids uuid[], p_guest_ids uuid[]) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM app.meeting_participants p WHERE p.meeting_id = p_meeting_id AND p.actor_id = ANY (p_speaker_ids) ORDER BY p.actor_id FOR SHARE;
  PERFORM 1 FROM app.meeting_guests g WHERE g.meeting_id = p_meeting_id AND g.id = ANY (p_guest_ids) ORDER BY g.id FOR SHARE;
  RETURN (SELECT count(*) FROM app.meeting_participants p WHERE p.meeting_id = p_meeting_id AND p.actor_id = ANY (p_speaker_ids) AND p.consent_transcribe = 'yes')
           = cardinality(ARRAY(SELECT DISTINCT unnest(p_speaker_ids)))
     AND (SELECT count(*) FROM app.meeting_guests g WHERE g.meeting_id = p_meeting_id AND g.id = ANY (p_guest_ids) AND g.consent_transcribe = 'yes')
           = cardinality(ARRAY(SELECT DISTINCT unnest(p_guest_ids)));
END
$$;
REVOKE ALL ON FUNCTION app.meeting_marks_speakers_said_yes(uuid, uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meeting_marks_speakers_said_yes(uuid, uuid[], uuid[]) TO manythreads_app, manythreads_system;

-- The call decides the place of a mark; a person marks only in a live call they are in now, as themself. Runs as the caller, so app.is_system() is the real role.
CREATE FUNCTION app.meeting_marks_before_insert() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m record;
BEGIN
  SELECT x.workspace_id, x.channel_id, x.team_id, x.state INTO m FROM app.meetings x WHERE x.id = NEW.meeting_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such call' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.workspace_id := m.workspace_id;
  NEW.channel_id := m.channel_id;
  NEW.team_id := m.team_id;
  NEW.created_at := now();
  IF NOT app.is_system() THEN
    IF m.state <> 'live' THEN
      RAISE EXCEPTION 'This call has ended' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.meeting_participants p WHERE p.meeting_id = NEW.meeting_id AND p.actor_id = NEW.marked_by AND p.left_at IS NULL) THEN
      RAISE EXCEPTION 'Only a person in the call can mark an action item' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (SELECT count(*) FROM app.meeting_marks k WHERE k.meeting_id = NEW.meeting_id AND k.marked_by = NEW.marked_by) >= 30 THEN
      RAISE EXCEPTION 'You marked 30 action items in this call already' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app.meeting_marks_speakers_said_yes(NEW.meeting_id, NEW.speaker_ids, NEW.guest_ids) THEN
      RAISE EXCEPTION 'Someone in those lines said no to being transcribed. Mark the action item again.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER meeting_marks_before_insert BEFORE INSERT ON app.meeting_marks FOR EACH ROW EXECUTE FUNCTION app.meeting_marks_before_insert();

ALTER TABLE app.meeting_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_marks_select ON app.meeting_marks FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])));
CREATE POLICY meeting_marks_insert ON app.meeting_marks FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (marked_by = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL AND workspace_id = (SELECT app.workspace_id())
      AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])));
CREATE POLICY meeting_marks_update ON app.meeting_marks FOR UPDATE USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_marks_delete ON app.meeting_marks FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.meeting_marks TO manythreads_app;
GRANT INSERT (meeting_id, marked_by, at_ms, text, speaker_ids, guest_ids) ON app.meeting_marks TO manythreads_app;

-- Reviews --------------------------------------------------------------------------------------------------------------------------------------------------------
-- `items` are the items to confirm, `confirmed_items` the ones confirmed: each `{ id, source, text, ownerId, ownerName, due, atMs }` (MeetingReviewItem in packages/shared).
CREATE TABLE app.meeting_reviews (
  meeting_id      uuid PRIMARY KEY REFERENCES app.meetings (id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL,
  team_id         uuid,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed')),
  items           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 50),
  confirmed_items jsonb CHECK (confirmed_items IS NULL OR (jsonb_typeof(confirmed_items) = 'array' AND jsonb_array_length(confirmed_items) <= 50)),
  -- the notes' action items are part of `items` (false: the notes were not written yet, or are the organizer's own copy)
  notes_included  boolean NOT NULL DEFAULT false,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  confirmed_by    uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_reviews_confirmed_shape CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL) AND (status = 'confirmed') = (confirmed_items IS NOT NULL))
);
CREATE INDEX meeting_reviews_workspace ON app.meeting_reviews (workspace_id);
CREATE INDEX meeting_reviews_confirmed_by ON app.meeting_reviews (confirmed_by) WHERE confirmed_by IS NOT NULL;
CREATE INDEX meeting_reviews_open ON app.meeting_reviews (opened_at) WHERE status = 'open';
COMMENT ON TABLE app.meeting_reviews IS 'rls: team — C: the end-of-call review of a call''s action items (P17-06): made by the platform; read by the people who were in the call while they can read its channel; confirmed once by one of them; everything else is the platform''s.';

-- A person only confirms an open review, as themself, with items of that review; nothing else of the row is theirs. Runs as the caller.
CREATE FUNCTION app.meeting_reviews_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'confirmed_items', 'confirmed_at', 'confirmed_by', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'confirmed_items', 'confirmed_at', 'confirmed_by', 'updated_at']) THEN
    RAISE EXCEPTION 'a review is only confirmed; the rest is the platform''s' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'open' OR NEW.status <> 'confirmed' THEN
    RAISE EXCEPTION 'This review was confirmed already' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.confirmed_by IS DISTINCT FROM app.actor() THEN
    RAISE EXCEPTION 'you confirm as yourself' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.confirmed_items) c
              WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.items) o WHERE o ->> 'id' = c ->> 'id')) THEN
    RAISE EXCEPTION 'only items of the review can be confirmed' USING ERRCODE = 'check_violation';
  END IF;
  NEW.confirmed_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER meeting_reviews_guard BEFORE UPDATE ON app.meeting_reviews FOR EACH ROW EXECUTE FUNCTION app.meeting_reviews_guard();

ALTER TABLE app.meeting_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_reviews_select ON app.meeting_reviews FOR SELECT USING (
  (SELECT app.is_system())
  OR (workspace_id = (SELECT app.workspace_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
      AND EXISTS (SELECT 1 FROM app.meeting_participants p WHERE p.meeting_id = meeting_reviews.meeting_id AND p.actor_id = (SELECT app.actor()))));
CREATE POLICY meeting_reviews_insert ON app.meeting_reviews FOR INSERT WITH CHECK ((SELECT app.is_system()));
CREATE POLICY meeting_reviews_update ON app.meeting_reviews FOR UPDATE
  USING (
    (SELECT app.is_system())
    OR (status = 'open' AND workspace_id = (SELECT app.workspace_id()) AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
        AND EXISTS (SELECT 1 FROM app.meeting_participants p WHERE p.meeting_id = meeting_reviews.meeting_id AND p.actor_id = (SELECT app.actor()))))
  WITH CHECK ((SELECT app.is_system()) OR (status = 'confirmed' AND confirmed_by = (SELECT app.actor())));
CREATE POLICY meeting_reviews_delete ON app.meeting_reviews FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT ON app.meeting_reviews TO manythreads_app;
GRANT UPDATE (status, confirmed_items, confirmed_at, confirmed_by, updated_at) ON app.meeting_reviews TO manythreads_app;

-- A person's no removes their marks too ---------------------------------------------------------------------------------------------------------------------
-- 0002's function as it was, and a no also removes every mark of the call that holds the caller's words (the lines it took are blanked above).
CREATE OR REPLACE FUNCTION app.meetings_set_consent(p_meeting_id uuid, p_answer text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.meetings;
  v_actor uuid := app.actor();
BEGIN
  IF p_answer NOT IN ('yes', 'no') THEN
    RAISE EXCEPTION 'answer yes or no' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO m FROM app.meetings WHERE id = p_meeting_id FOR SHARE;
  IF NOT FOUND OR m.workspace_id <> app.workspace_id() THEN
    RAISE EXCEPTION 'no such voice room' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_actor IS NULL OR app.person_id() IS NULL THEN
    RAISE EXCEPTION 'only a person answers for themself' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.state <> 'live' THEN
    RAISE EXCEPTION 'This voice room has ended' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.meeting_participants SET consent_transcribe = p_answer
   WHERE meeting_id = m.id AND actor_id = v_actor AND left_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'join the voice room first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_answer = 'no' THEN
    UPDATE app.meeting_segments SET text = '' WHERE meeting_id = m.id AND speaker_id = v_actor AND text <> '';
    DELETE FROM app.meeting_marks WHERE meeting_id = m.id AND v_actor = ANY (speaker_ids);
  END IF;
  RETURN p_answer;
END
$$;

-- Owners -----------------------------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.meeting_marks_speakers_said_yes(uuid, uuid[], uuid[]) OWNER TO manythreads_system;
ALTER FUNCTION app.meetings_set_consent(uuid, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
