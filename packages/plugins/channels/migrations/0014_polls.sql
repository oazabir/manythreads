-- channels 0014: polls (PLAN P14-07). Forward-only: never edit once applied.
--
-- A poll is a message of a channel plus a row here: a question, two to ten options, whether several may be chosen, whether votes are anonymous,
-- and an optional closing time. Whoever can read the channel reads the poll and may vote (a person, never a bot). The author closes it early; a
-- minute job in the plugin closes it at its time and posts the result as a plain message. The author, a team lead of the channel's team or a workspace
-- admin may close it early (app.polls_close below); a poll whose message was deleted takes no more votes.
--
-- THE COUNTS ARE KEPT ON THE POLL. `vote_counts` (one number per option) and `voter_count` are changed only by the triggers below, in the same
-- statement as the vote, so every reader of the channel sees the totals without reading a single ballot. That is what lets a ballot of an
-- ANONYMOUS poll stay unreadable to everybody but the person who cast it.
--
-- A BALLOT is one row per voter and poll: `poll_votes.choices` holds the options chosen. A ballot of a named poll is readable by whoever can read
-- the channel. A ballot of an anonymous poll is readable by its voter only: no other person, no workspace admin, no team lead, and not the system
-- role either (the one system policy below covers named polls only). The ballot still needs the voter's id, to change or withdraw a vote and to
-- count each person once, so the protection is the row-level policy, not the absence of the id.
--
-- Inside a definer function app.is_system() is true (the function is owned by manythreads_system), so the triggers and the voters function below check
-- the caller by hand where it matters (the visibility set, the poll being named); none of them reads an anonymous ballot.

CREATE TABLE app.polls (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  channel_id        uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  -- the message that shows the poll; the poll goes with it when the message row is removed (a deleted message keeps its row, so its poll stays but is not shown)
  message_id        uuid NOT NULL UNIQUE REFERENCES app.messages (id) ON DELETE CASCADE,
  author_id         uuid NOT NULL REFERENCES app.actors (id),
  question          text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  options           text[] NOT NULL CHECK (cardinality(options) BETWEEN 2 AND 10),
  multiple          boolean NOT NULL DEFAULT false,
  anonymous         boolean NOT NULL DEFAULT false,
  closes_at         timestamptz,
  closed_at         timestamptz,
  closed_by         uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  -- the plain-text result message; null while open, and when it could not be posted
  result_message_id uuid REFERENCES app.messages (id) ON DELETE SET NULL,
  -- one number per option, and how many people voted; changed only by the poll_votes triggers
  vote_counts       integer[] NOT NULL,
  voter_count       integer NOT NULL DEFAULT 0 CHECK (voter_count >= 0),
  -- goes up by one with every change of the row (a vote, a withdrawal, the close), so a page can tell an older answer or push from a newer one
  version           integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(vote_counts) = cardinality(options))
);
CREATE INDEX polls_channel ON app.polls (channel_id);
CREATE INDEX polls_workspace ON app.polls (workspace_id);
CREATE INDEX polls_author ON app.polls (author_id);
CREATE INDEX polls_closed_by ON app.polls (closed_by) WHERE closed_by IS NOT NULL;
CREATE INDEX polls_result_message ON app.polls (result_message_id) WHERE result_message_id IS NOT NULL;
-- the minute job's whole working set
CREATE INDEX polls_due ON app.polls (closes_at, id) WHERE closed_at IS NULL AND closes_at IS NOT NULL;
COMMENT ON TABLE app.polls IS 'rls: team — C: polls of the channels the caller can read (app.visible_channel_ids); created by whoever can post, closed by its author; the totals are kept by the poll_votes triggers.';

CREATE TABLE app.poll_votes (
  poll_id    uuid NOT NULL REFERENCES app.polls (id) ON DELETE CASCADE,
  voter_id   uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  -- both copied from the poll by the trigger, so the policy can probe the visibility set and tell an anonymous ballot from a named one
  channel_id uuid NOT NULL,
  anonymous  boolean NOT NULL,
  choices    smallint[] NOT NULL CHECK (cardinality(choices) BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, voter_id)
);
CREATE INDEX poll_votes_voter ON app.poll_votes (voter_id);
COMMENT ON TABLE app.poll_votes IS 'rls: team — C: ballots of the channels the caller can read (app.visible_channel_ids); a named poll''s ballots are read by anyone who reads the channel, an anonymous poll''s by its voter only (not by admins and not by the system role); a person writes only their own ballot.';

-- polls: what a new poll must be, whoever inserts it. The counts start at zero; the workspace, the channel and the author are those of the message.
CREATE FUNCTION app.polls_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  m app.messages;
BEGIN
  SELECT * INTO m FROM app.messages WHERE id = NEW.message_id;
  IF NOT FOUND OR m.channel_id <> NEW.channel_id OR m.workspace_id <> NEW.workspace_id OR m.author_id <> NEW.author_id THEN
    RAISE EXCEPTION 'a poll belongs to a message of the same channel and author' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.options) o WHERE char_length(o) NOT BETWEEN 1 AND 100) THEN
    RAISE EXCEPTION 'an option has 1 to 100 characters' USING ERRCODE = 'check_violation';
  END IF;
  -- one line each: a line break or another control character would forge lines in the poll message and in its result
  IF NEW.question ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]' OR EXISTS (SELECT 1 FROM unnest(NEW.options) o WHERE o ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]') THEN
    RAISE EXCEPTION 'write the question and the options on one line, without control characters' USING ERRCODE = 'check_violation';
  END IF;
  -- the same rule as pollOptionKey in packages/shared: spaces collapsed and trimmed, capitals ignored
  IF (SELECT count(DISTINCT lower(btrim(regexp_replace(o, '\s+', ' ', 'g')))) FROM unnest(NEW.options) o) <> cardinality(NEW.options) THEN
    RAISE EXCEPTION 'two options are the same' USING ERRCODE = 'check_violation';
  END IF;
  NEW.vote_counts := array_fill(0, ARRAY[cardinality(NEW.options)]);
  NEW.voter_count := 0;
  NEW.closed_at := NULL;
  NEW.closed_by := NULL;
  NEW.result_message_id := NULL;
  NEW.version := 0;
  RETURN NEW;
END
$$;
CREATE TRIGGER polls_before_insert BEFORE INSERT ON app.polls FOR EACH ROW EXECUTE FUNCTION app.polls_before_insert();

-- polls: what a caller may change directly. Only the author closes an open poll, once (the close time, who closed it, and the result message); a team lead
-- or an admin closes through app.polls_close. Every change bumps the version, whoever makes it. The totals,
-- the question, the options and the rules never change; the poll_votes triggers (definer, so app.is_system() is true there) move the totals.
CREATE FUNCTION app.polls_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    IF (to_jsonb(NEW) - 'closed_at' - 'closed_by' - 'result_message_id' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'closed_at' - 'closed_by' - 'result_message_id' - 'version') THEN
      RAISE EXCEPTION 'a poll changes only by being closed' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.closed_at IS NOT NULL AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closed_by IS DISTINCT FROM OLD.closed_by) THEN
      RAISE EXCEPTION 'this poll is already closed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.closed_at IS NOT NULL AND OLD.closed_at IS NULL AND NEW.closed_by IS DISTINCT FROM app.actor() THEN
      RAISE EXCEPTION 'a poll is closed by its author' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;
CREATE TRIGGER polls_guard BEFORE UPDATE ON app.polls FOR EACH ROW EXECUTE FUNCTION app.polls_guard();

-- poll_votes: a ballot is checked against the poll, which is locked first (FOR UPDATE), so a vote and the closing of the poll take turns and the
-- result message always counts exactly the votes made before the poll closed. Votes are refused once the poll is closed or its time has passed
-- (the minute job may not have recorded the closing yet), for an option that does not exist, for two options in a single-choice poll.
CREATE FUNCTION app.poll_votes_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  p app.polls;
BEGIN
  SELECT * INTO p FROM app.polls WHERE id = NEW.poll_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such poll' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.poll_id <> OLD.poll_id OR NEW.voter_id <> OLD.voter_id) THEN
    RAISE EXCEPTION 'a ballot keeps its poll and its voter' USING ERRCODE = 'check_violation';
  END IF;
  IF p.closed_at IS NOT NULL OR (p.closes_at IS NOT NULL AND p.closes_at <= now()) THEN
    RAISE EXCEPTION 'This poll is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.messages m WHERE m.id = p.message_id AND m.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'That poll was deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.choices) c WHERE c < 0 OR c >= cardinality(p.options)) THEN
    RAISE EXCEPTION 'That option does not exist' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT c) FROM unnest(NEW.choices) c) <> cardinality(NEW.choices) THEN
    RAISE EXCEPTION 'An option can be chosen once' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT p.multiple AND cardinality(NEW.choices) <> 1 THEN
    RAISE EXCEPTION 'This poll takes one choice' USING ERRCODE = 'check_violation';
  END IF;
  NEW.channel_id := p.channel_id;
  NEW.anonymous := p.anonymous;
  NEW.choices := ARRAY(SELECT c FROM unnest(NEW.choices) c ORDER BY c);
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER poll_votes_check BEFORE INSERT OR UPDATE ON app.poll_votes FOR EACH ROW EXECUTE FUNCTION app.poll_votes_check();

-- poll_votes: a ballot is withdrawn only while the poll is open; the delete that follows the poll's own deletion (the cascade) finds no poll and passes.
CREATE FUNCTION app.poll_votes_check_delete() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  p app.polls;
BEGIN
  SELECT * INTO p FROM app.polls WHERE id = OLD.poll_id FOR UPDATE;
  IF FOUND AND (p.closed_at IS NOT NULL OR (p.closes_at IS NOT NULL AND p.closes_at <= now())) THEN
    RAISE EXCEPTION 'This poll is closed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER poll_votes_check_delete BEFORE DELETE ON app.poll_votes FOR EACH ROW EXECUTE FUNCTION app.poll_votes_check_delete();

-- poll_votes: the totals follow the ballots, in the same statement. A changed ballot takes back its old choices and adds its new ones.
CREATE FUNCTION app.poll_votes_count() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_poll    uuid := coalesce(NEW.poll_id, OLD.poll_id);
  v_minus   smallint[] := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.choices ELSE '{}'::smallint[] END;
  v_plus    smallint[] := CASE WHEN TG_OP IN ('UPDATE', 'INSERT') THEN NEW.choices ELSE '{}'::smallint[] END;
  v_voters  integer := CASE TG_OP WHEN 'INSERT' THEN 1 WHEN 'DELETE' THEN -1 ELSE 0 END;
BEGIN
  UPDATE app.polls p
     SET vote_counts = (SELECT array_agg(t.c + (CASE WHEN (t.i - 1)::smallint = ANY (v_plus) THEN 1 ELSE 0 END) - (CASE WHEN (t.i - 1)::smallint = ANY (v_minus) THEN 1 ELSE 0 END) ORDER BY t.i)
                          FROM unnest(p.vote_counts) WITH ORDINALITY AS t(c, i)),
         voter_count = p.voter_count + v_voters
   WHERE p.id = v_poll;
  RETURN NULL;
END
$$;
CREATE TRIGGER poll_votes_count AFTER INSERT OR UPDATE OR DELETE ON app.poll_votes FOR EACH ROW EXECUTE FUNCTION app.poll_votes_count();

-- Closing a poll early, by its author, a team lead of the channel's team or a workspace admin (the same people who manage the channel). The poll is locked,
-- so a vote in flight and the close take turns; the result message (posted just before, by the same caller) counted exactly the votes made before. The system
-- role (the minute job's last resort) closes with no check, and records nobody as the closer. Returns false when the poll was already closed.
CREATE FUNCTION app.polls_close(p_poll_id uuid, p_result_message_id uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  p app.polls;
BEGIN
  SELECT * INTO p FROM app.polls WHERE id = p_poll_id FOR UPDATE;
  IF NOT FOUND OR p.workspace_id <> app.workspace_id() THEN
    RAISE EXCEPTION 'no such poll' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF session_user <> 'manythreads_system' THEN
    IF app.actor() IS NULL OR NOT p.channel_id = ANY (app.visible_channel_ids('read'))
       OR (p.author_id <> app.actor() AND NOT coalesce(app.lookup_channel_can(p.channel_id, 'manage'), false)) THEN
      RAISE EXCEPTION 'only the author, a team lead or an admin can close this poll' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF p.closed_at IS NOT NULL THEN
    RETURN false;
  END IF;
  UPDATE app.polls SET closed_at = now(), closed_by = CASE WHEN session_user = 'manythreads_system' THEN NULL ELSE app.actor() END,
                       result_message_id = p_result_message_id
   WHERE id = p_poll_id;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.polls_close(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.polls_close(uuid, uuid) TO manythreads_app;

-- Takes the lock that serialises a close with the votes in flight, for a caller who may close but may not update the row (a team lead or an admin: the
-- update policy is the author's alone, and SELECT ... FOR UPDATE obeys it, so the row would look missing). Same permission as app.polls_close; the
-- caller then reads the totals it will print, and polls_close closes under the same lock. Nothing is changed here.
CREATE FUNCTION app.polls_lock(p_poll_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  p app.polls;
BEGIN
  SELECT * INTO p FROM app.polls WHERE id = p_poll_id FOR UPDATE;
  IF NOT FOUND OR p.workspace_id <> app.workspace_id() THEN
    RAISE EXCEPTION 'no such poll' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF session_user <> 'manythreads_system' THEN
    IF app.actor() IS NULL OR NOT p.channel_id = ANY (app.visible_channel_ids('read'))
       OR (p.author_id <> app.actor() AND NOT coalesce(app.lookup_channel_can(p.channel_id, 'manage'), false)) THEN
      RAISE EXCEPTION 'only the author, a team lead or an admin can close this poll' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.polls_lock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.polls_lock(uuid) TO manythreads_app;

-- Who voted for what in a NAMED poll, for a caller who can read its channel; nothing at all for an anonymous poll, whoever asks. The function is owned
-- by the system role, whose policy on poll_votes covers named polls only, so even a mistake in this body could not return an anonymous ballot.
CREATE FUNCTION app.poll_voters(p_poll_id uuid) RETURNS TABLE (actor_id uuid, display_name text, choices smallint[])
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF app.actor() IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT v.voter_id, coalesce(pe.display_name, 'Someone'), v.choices
    FROM app.polls p
    JOIN app.poll_votes v ON v.poll_id = p.id AND NOT v.anonymous
    JOIN app.actors a ON a.id = v.voter_id
    LEFT JOIN app.people pe ON a.kind = 'person' AND pe.id = a.ref_id AND pe.workspace_id = a.workspace_id
   WHERE p.id = p_poll_id AND NOT p.anonymous AND p.workspace_id = app.workspace_id()
     AND p.channel_id = ANY (app.visible_channel_ids('read'))
   ORDER BY v.created_at, v.voter_id;
END
$$;
REVOKE ALL ON FUNCTION app.poll_voters(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.poll_voters(uuid) TO manythreads_app;

-- Row level security ---------------------------------------------------------------------------------------------------------------
ALTER TABLE app.polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.polls FORCE ROW LEVEL SECURITY;
CREATE POLICY polls_select ON app.polls FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY polls_insert ON app.polls FOR INSERT WITH CHECK (
  (SELECT app.is_system()) OR (
    author_id = (SELECT app.actor()) AND workspace_id = (SELECT app.workspace_id())
    AND channel_id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])));
-- the author closes the poll (the guard allows nothing else); the system role's updates are the poll_votes triggers' (the totals) and the job's
CREATE POLICY polls_update ON app.polls FOR UPDATE
  USING ((SELECT app.is_system()) OR author_id = (SELECT app.actor()))
  WITH CHECK ((SELECT app.is_system()) OR (author_id = (SELECT app.actor()) AND workspace_id = (SELECT app.workspace_id())));

ALTER TABLE app.poll_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.poll_votes FORCE ROW LEVEL SECURITY;
-- A named poll's ballots: whoever can read the channel. An anonymous poll's ballots: their voter, and nobody else.
CREATE POLICY poll_votes_select ON app.poll_votes FOR SELECT
  USING (channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]) AND (NOT anonymous OR voter_id = (SELECT app.actor())));
-- The system role (the functions above are owned by it) sees the ballots of named polls only. There is deliberately no system policy for anything else.
CREATE POLICY poll_votes_system_named ON app.poll_votes FOR SELECT
  USING ((SELECT app.is_system()) AND NOT anonymous);
-- A person (never a bot) who can read the channel casts, changes and withdraws their own ballot.
CREATE POLICY poll_votes_insert ON app.poll_votes FOR INSERT WITH CHECK (
  voter_id = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL
  AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY poll_votes_update ON app.poll_votes FOR UPDATE
  USING (voter_id = (SELECT app.actor()))
  WITH CHECK (voter_id = (SELECT app.actor()) AND (SELECT app.person_id()) IS NOT NULL AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY poll_votes_delete ON app.poll_votes FOR DELETE
  USING (voter_id = (SELECT app.actor()));

GRANT SELECT, INSERT, UPDATE ON app.polls TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.poll_votes TO manythreads_app;

-- The definer functions run as the system role, so they pass the system policies above (and only those).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.polls_before_insert() OWNER TO manythreads_system;
ALTER FUNCTION app.poll_votes_check() OWNER TO manythreads_system;
ALTER FUNCTION app.poll_votes_check_delete() OWNER TO manythreads_system;
ALTER FUNCTION app.poll_votes_count() OWNER TO manythreads_system;
ALTER FUNCTION app.poll_voters(uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.polls_close(uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.polls_lock(uuid) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
