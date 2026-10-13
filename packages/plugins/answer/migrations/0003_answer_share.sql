-- answer 0003: sharing an answer (PLAN P5-17, SPEC §6.3 and §6.4). Forward-only: never edit once applied.
--
-- A person's answer lives in their own conversation with a bot: private to them, an admin included. Three acts make its content reach other
-- people, and all three need the same two things the platform must decide and the sharer cannot be trusted with:
--
--   * who will READ the place it goes to (a channel's actual readers; the team's pages: the team and its admins), and
--   * which of its citations those readers may open — decided by the platform's own policies as the sharer, per citation, against that reach.
--
-- 1. app.answer_channel_reach(channel, team, asker): the one rule "who reads this channel", extracted from 0001's `answer_reply_reach` so that a
--    reply posted by a bot (`answer.post`) and a copy shared by a person (this migration) are judged by ONE function over
--    `app.channel_audience`, not by two that drift. `answer_reply_reach()` becomes a wrapper that finds the run's channel, team and asker.
-- 2. app.answer_shares: the access log of a share (who, which answer, where, how many kept / masked / removed — numbers, never ids or text of a
--    source) and the key of its idempotency (answer + target + sharer + digest of the copy).
-- 3. app.answer_share_view(message, channel, page): the sharer's view of ONE answer of their own conversation against a target: the stored
--    payload, the target (does it exist for them, may they post there), the reach, and a verdict per citation and per source reached. SECURITY
--    INVOKER, like `answer_view`: the citations are re-read as the caller under the same forced RLS every request has — a source the sharer can
--    no longer open is masked as well, a message edited or deleted since is read again, never copied.
-- 4. app.answer_share_find / app.answer_share_record: the replay lookup (under a lock of the share's key) and the write of the log line, as
--    SECURITY DEFINER doors that check the caller is the answer's asker.

-- 1. The reach ------------------------------------------------------------------------------------------------------------------------
-- Who will read `p_channel`, for an answer of `p_asker` whose bot belongs to `p_team`, from the channel's ACTUAL readers (one `channel_audience`
-- read; the caller must be able to read the channel, or the answer is `none`):
--   * `asker`: a bot conversation whose only reader is the asker — everything the asker may open may be shown;
--   * `team`: a channel of `p_team` whose every reader is a workspace owner/admin or an active, non-guest workspace member on that team's roster
--     (the test `lookup_team_role` applies: a roster row alone is not membership) — a team source may be shown;
--   * `none`: anybody else may read it, the caller cannot read it, or it has no readers: only what lives in the channel itself may be shown.
CREATE FUNCTION app.answer_channel_reach(p_channel uuid, p_team uuid, p_asker uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  WITH ch AS (
    SELECT c.id, c.kind, c.team_id, c.workspace_id
      FROM app.channels c
     WHERE c.id = p_channel AND c.workspace_id = app.workspace_id() AND app.lookup_channel_can(c.id, 'read')
  ), a AS MATERIALIZED (
    SELECT x.person_id FROM ch, app.channel_audience(ch.id) AS x
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM ch) OR NOT EXISTS (SELECT 1 FROM a) THEN 'none'
    WHEN (SELECT ch.kind FROM ch) = 'bot_conversation'
         AND p_asker IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM a WHERE a.person_id <> p_asker) THEN 'asker'
    WHEN (SELECT ch.kind FROM ch) = 'channel'
         AND (SELECT ch.team_id FROM ch) = p_team
         AND NOT EXISTS (
           SELECT 1 FROM a, ch
            WHERE NOT EXISTS (SELECT 1 FROM app.workspace_members wm
                               WHERE wm.workspace_id = ch.workspace_id AND wm.person_id = a.person_id AND wm.role IN ('owner', 'admin'))
              AND NOT EXISTS (SELECT 1 FROM app.team_members tm
                                JOIN app.actors pa ON pa.id = tm.actor_id AND pa.kind = 'person'
                                JOIN app.people p ON p.id = pa.ref_id AND p.status = 'active'
                                JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id AND wm.role <> 'guest'
                               WHERE tm.team_id = ch.team_id AND pa.ref_id = a.person_id)) THEN 'team'
    ELSE 'none'
  END
$$;

-- The same answer as 0001 for the same inputs: the run's own channel, team and asker, for the run's own bot only.
CREATE OR REPLACE FUNCTION app.answer_reply_reach() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT coalesce((
    SELECT app.answer_channel_reach(r.channel_id, r.team_id, asker.ref_id)
      FROM app.bot_runs r
      JOIN app.actors bot ON bot.kind = 'bot' AND bot.ref_id = r.bot_id AND bot.workspace_id = r.workspace_id
      LEFT JOIN app.actors asker ON asker.id = r.asker_id AND asker.kind = 'person'
     WHERE r.id = app.run_id() AND r.status = 'running' AND r.ended_at IS NULL AND app.actor() = bot.id
  ), 'none')
$$;

-- 2. The log of a share ---------------------------------------------------------------------------------------------------------------
CREATE TABLE app.answer_shares (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  -- the answer: a message of the sharer's own conversation
  message_id      uuid NOT NULL REFERENCES app.messages (id) ON DELETE CASCADE,
  -- `channel`: a masked copy posted into `channel_id`; `page`: saved under `path`; `handoff`: given to another bot, in `channel_id`
  kind            text NOT NULL CHECK (kind IN ('channel', 'page', 'handoff')),
  channel_id      uuid REFERENCES app.channels (id) ON DELETE CASCADE,
  path            text,
  shared_by       uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  -- sha-256 of what was written (the copy, the target): the same share again has the same digest, a different cut a different one
  digest          text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  -- the message that was posted (a channel copy, a hand-off's first message); no foreign key: a deleted copy must not delete the log of it
  copy_message_id uuid,
  kept_count      integer NOT NULL CHECK (kept_count >= 0),
  masked_count    integer NOT NULL CHECK (masked_count >= 0),
  removed_count   integer NOT NULL CHECK (removed_count >= 0),
  -- the positions of the citations in the answer (1..40), never anything about the sources
  masked_numbers  integer[] NOT NULL DEFAULT '{}',
  removed_numbers integer[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- the idempotency key; a page has no channel, and a unique index treats NULLs as different, so the key is a column that never is
  channel_key     uuid GENERATED ALWAYS AS (coalesce(channel_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  CONSTRAINT answer_shares_shape CHECK ((kind = 'page') = (path IS NOT NULL) AND (kind = 'page') = (channel_id IS NULL))
);
CREATE UNIQUE INDEX answer_shares_key ON app.answer_shares (message_id, kind, shared_by, channel_key, digest);
CREATE INDEX answer_shares_person ON app.answer_shares (shared_by, created_at DESC);
CREATE INDEX answer_shares_workspace ON app.answer_shares (workspace_id);
CREATE INDEX answer_shares_channel ON app.answer_shares (channel_id) WHERE channel_id IS NOT NULL;
COMMENT ON TABLE app.answer_shares IS 'rls: person — P: the access log of an answer share (who, which answer, where, how many citations kept / masked / removed); the sharer reads their own lines, written by the system role only (app.answer_share_record). Holds no text and no id of a source.';

ALTER TABLE app.answer_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.answer_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY answer_shares_select ON app.answer_shares FOR SELECT USING (
  (SELECT app.is_system()) OR shared_by = (SELECT app.person_id())
);
CREATE POLICY answer_shares_system ON app.answer_shares FOR ALL
  USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.answer_shares TO manythreads_app;

-- 3. The sharer's view ----------------------------------------------------------------------------------------------------------------
-- NULL: there is no such answer for the caller (a message that is not theirs, not an answer, deleted, not in their own conversation: all alike).
-- Otherwise `{ answer, target, reach, citations, sources }`:
--   * `answer`: the message, its thread, the bot's team, and the stored payload (`meta.answer`) — read as the caller;
--   * `target`: the channel as the caller may read it (`null` when they cannot, or it does not exist: alike), with `canPost`; for a page, the team;
--   * `reach`: `asker` | `team` | `none` (see app.answer_channel_reach; a page of the answer's team is read by that team and its admins: `team`;
--     a target that is not readable is `none`);
--   * `citations[i]` = `{ n, kept, label, at }` for the i-th stored citation, `kept` when the caller can open the source NOW and the readers may
--     (the source is team-readable, or lives in the target channel itself, or the reach is `asker`); the label and date are the current ones;
--   * `sources[i]` = `{ kept }` for the i-th entry of "Sources reached": only message, file, page and run entries can be proven; every other
--     kind is not kept (an unknown source is never shown).
-- The decision is `app.answer_resolve` as the sharer against `reach` — no scope label of the stored payload decides anything.
CREATE FUNCTION app.answer_share_view(p_message uuid, p_channel uuid, p_page boolean DEFAULT false) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_me      uuid := app.person_id();
  v_actor   uuid := app.actor();
  v_role    text;
  m         record;
  t         record;
  v_payload jsonb;
  v_reach   text := 'none';
  v_target  jsonb := NULL;
  c         record;
  v_kind    text;
  v_ref     text;
  v_n       integer;
  v_team    uuid;
  v_res     jsonb;
  v_cites   jsonb := '[]'::jsonb;
  v_srcs    jsonb := '[]'::jsonb;
  v_ok      boolean;
BEGIN
  IF v_me IS NULL OR v_actor IS NULL OR (p_channel IS NOT NULL AND p_page) THEN
    RETURN NULL;
  END IF;
  v_role := app.lookup_workspace_role();
  IF v_role IS NULL OR v_role = 'guest' THEN
    RETURN NULL;
  END IF;

  -- the answer: a live message of the caller's OWN conversation, an Answer for the caller from that conversation's bot
  SELECT x.id, x.channel_id, x.thread_root_id, x.meta, ch.team_id, ch.bot_id
    INTO m
    FROM app.messages x
    JOIN app.channels ch ON ch.id = x.channel_id
   WHERE x.id = p_message AND x.deleted_at IS NULL
     AND ch.kind = 'bot_conversation' AND ch.created_by = v_actor AND ch.team_id IS NOT NULL
     AND x.meta ? 'answer'
     AND (x.meta -> 'answer' -> 'answeredFor' ->> 'personId') = v_me::text
     AND (x.meta -> 'answer' -> 'answeredFor' ->> 'botId') = ch.bot_id::text;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_payload := m.meta -> 'answer';

  IF p_channel IS NOT NULL THEN
    SELECT c2.id, c2.kind, c2.name, c2.team_id, c2.private, c2.archived_at INTO t FROM app.channels c2 WHERE c2.id = p_channel;
    IF FOUND THEN
      v_target := jsonb_build_object(
        'kind', t.kind, 'channelId', t.id, 'name', CASE WHEN t.kind = 'channel' THEN t.name END, 'teamId', t.team_id, 'private', t.private,
        'archived', t.archived_at IS NOT NULL, 'canPost', coalesce(app.lookup_channel_can(t.id, 'post'), false));
      v_reach := coalesce(app.answer_channel_reach(t.id, m.team_id, v_me), 'none');
    END IF;
  ELSIF p_page THEN
    -- the team's pages are read by the team and its admins: the readers of the repo, which is the `team` reach for the answer's own team
    v_reach := 'team';
    v_target := jsonb_build_object('kind', 'page', 'channelId', NULL, 'name', NULL, 'teamId', m.team_id, 'private', false, 'archived', false, 'canPost', true);
  END IF;

  IF v_target IS NOT NULL THEN
    FOR c IN
      SELECT j.value AS v
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_payload -> 'citations') = 'array' THEN v_payload -> 'citations' ELSE '[]'::jsonb END) AS j(value)
       LIMIT 40
    LOOP
      v_kind := c.v ->> 'kind';
      v_n := CASE WHEN (c.v ->> 'n') ~ '^[0-9]{1,3}$' THEN (c.v ->> 'n')::integer END;
      IF v_n IS NULL THEN
        CONTINUE;
      END IF;
      v_ref := CASE v_kind
        WHEN 'message' THEN c.v ->> 'messageId' WHEN 'thread' THEN c.v ->> 'threadRootId' WHEN 'page' THEN c.v ->> 'path'
        WHEN 'file' THEN c.v ->> 'fileId' WHEN 'run' THEN c.v ->> 'runId' END;
      v_team := CASE WHEN v_kind = 'page' AND (c.v ->> 'teamId') ~* v_uuid_re THEN (c.v ->> 'teamId')::uuid END;
      IF v_ref IS NULL THEN
        v_res := jsonb_build_object('found', false);
      ELSE
        v_res := app.answer_resolve(v_kind, v_ref, v_team, m.team_id, p_channel, v_reach);
      END IF;
      v_ok := coalesce((v_res ->> 'found')::boolean, false) AND coalesce((v_res ->> 'audience')::boolean, false);
      v_cites := v_cites || jsonb_build_array(jsonb_build_object(
        'n', v_n, 'kept', v_ok, 'label', CASE WHEN v_ok THEN v_res -> 'label' END, 'at', CASE WHEN v_ok THEN v_res -> 'at' END));
    END LOOP;

    FOR c IN
      SELECT j.value AS v
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_payload -> 'sourcesReached') = 'array' THEN v_payload -> 'sourcesReached' ELSE '[]'::jsonb END) AS j(value)
       LIMIT 100
    LOOP
      v_kind := c.v ->> 'kind';
      v_ref := c.v ->> 'ref';
      IF v_ref IS NULL THEN
        v_res := jsonb_build_object('found', false);
      ELSIF v_kind IN ('message', 'file', 'run') AND v_ref ~* v_uuid_re THEN
        v_res := app.answer_resolve(v_kind, v_ref, NULL, m.team_id, p_channel, v_reach);
      ELSIF v_kind = 'page' THEN
        -- the log names a page of another team as `<team id>:<path>`
        IF v_ref ~* ('^' || substr(v_uuid_re, 2, length(v_uuid_re) - 2) || ':') THEN
          v_res := app.answer_resolve('page', substr(v_ref, 38), left(v_ref, 36)::uuid, m.team_id, p_channel, v_reach);
        ELSE
          v_res := app.answer_resolve('page', v_ref, NULL, m.team_id, p_channel, v_reach);
        END IF;
      ELSE
        v_res := jsonb_build_object('found', false);
      END IF;
      v_srcs := v_srcs || jsonb_build_array(jsonb_build_object(
        'kept', coalesce((v_res ->> 'found')::boolean, false) AND coalesce((v_res ->> 'audience')::boolean, false)));
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'answer', jsonb_build_object(
      'messageId', m.id, 'channelId', m.channel_id, 'threadRootId', m.thread_root_id, 'teamId', m.team_id, 'botId', m.bot_id,
      'personId', v_me, 'payload', v_payload),
    'target', v_target,
    'reach', v_reach,
    'citations', v_cites,
    'sources', v_srcs);
END
$$;

-- 4. Replay and record ----------------------------------------------------------------------------------------------------------------
-- The one share of this key made by the caller whose copy is still there: the message id of the copy, else NULL. Takes the key's advisory lock
-- first (to the end of the transaction), so two requests for one share go one after the other and the second finds the first's copy.
CREATE FUNCTION app.answer_share_find(p_message uuid, p_kind text, p_channel uuid, p_digest text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_me    uuid := app.person_id();
  v_found uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'answer-share:' || p_message::text || ':' || p_kind || ':' || coalesce(p_channel::text, '') || ':' || v_me::text || ':' || coalesce(p_digest, ''), 0));
  SELECT s.copy_message_id INTO v_found
    FROM app.answer_shares s
    JOIN app.messages cm ON cm.id = s.copy_message_id AND cm.deleted_at IS NULL
   WHERE s.message_id = p_message AND s.kind = p_kind AND s.shared_by = v_me
     AND s.channel_key = coalesce(p_channel, '00000000-0000-0000-0000-000000000000'::uuid) AND s.digest = p_digest;
  RETURN v_found;
END
$$;

-- Writes the log line of a share the caller has just made. The caller must be the answer's asker (the same test as the view's), the copy their
-- own message in the target channel. A second record of the same key (a copy that was deleted and shared again) replaces the pointer.
CREATE FUNCTION app.answer_share_record(
  p_message uuid, p_kind text, p_channel uuid, p_path text, p_digest text, p_copy uuid,
  p_kept integer, p_masked integer[], p_removed integer[]
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_me  uuid := app.person_id();
  v_ws  uuid := app.workspace_id();
  v_id  uuid;
BEGIN
  IF v_me IS NULL OR v_ws IS NULL THEN
    RAISE EXCEPTION 'only a person can share an answer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.messages x JOIN app.channels ch ON ch.id = x.channel_id
     WHERE x.id = p_message AND x.workspace_id = v_ws AND x.deleted_at IS NULL
       AND ch.kind = 'bot_conversation' AND ch.created_by = app.actor()
       AND x.meta ? 'answer' AND (x.meta -> 'answer' -> 'answeredFor' ->> 'personId') = v_me::text
  ) THEN
    RAISE EXCEPTION 'this is not your answer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_copy IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.messages c WHERE c.id = p_copy AND c.channel_id = p_channel AND c.author_id = app.actor() AND c.workspace_id = v_ws
  ) THEN
    RAISE EXCEPTION 'the copy is not your message in that channel' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.answer_shares AS s
    (workspace_id, message_id, kind, channel_id, path, shared_by, digest, copy_message_id, kept_count, masked_count, removed_count, masked_numbers, removed_numbers)
  VALUES
    (v_ws, p_message, p_kind, p_channel, p_path, v_me, p_digest, p_copy, greatest(p_kept, 0), coalesce(cardinality(p_masked), 0), coalesce(cardinality(p_removed), 0),
     coalesce(p_masked, '{}'::integer[]), coalesce(p_removed, '{}'::integer[]))
  ON CONFLICT (message_id, kind, shared_by, channel_key, digest)
  DO UPDATE SET copy_message_id = EXCLUDED.copy_message_id, created_at = now()
  RETURNING s.id INTO v_id;
  RETURN v_id;
END
$$;

-- Grants and owners --------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.answer_channel_reach(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.answer_share_view(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.answer_share_find(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.answer_share_record(uuid, text, uuid, text, text, uuid, integer, integer[], integer[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.answer_channel_reach(uuid, uuid, uuid) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.answer_share_view(uuid, uuid, boolean) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.answer_share_find(uuid, text, uuid, text) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.answer_share_record(uuid, text, uuid, text, text, uuid, integer, integer[], integer[]) TO manythreads_app, manythreads_system;
-- `answer_reply_reach` keeps its 0001 grants and owner (CREATE OR REPLACE changes neither); stated again so this file is complete.
REVOKE ALL ON FUNCTION app.answer_reply_reach() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.answer_reply_reach() TO manythreads_app, manythreads_system;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.answer_channel_reach(uuid, uuid, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.answer_reply_reach() OWNER TO manythreads_system;
ALTER FUNCTION app.answer_share_find(uuid, text, uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.answer_share_record(uuid, text, uuid, text, text, uuid, integer, integer[], integer[]) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

COMMENT ON FUNCTION app.answer_channel_reach(uuid, uuid, uuid) IS
  'Who will read a channel, for an answer of a person whose bot is on a team (answer plugin): asker | team | none, from the channel''s actual readers (app.channel_audience), for a caller who can read it. The one rule behind a bot reply (answer_reply_reach) and a shared copy (answer_share_view).';
COMMENT ON FUNCTION app.answer_share_view(uuid, uuid, boolean) IS
  'The sharer''s view of one answer of their own conversation against a target channel or the team''s pages (SECURITY INVOKER: every citation is re-read as the caller under RLS): the payload, the target, the reach and a verdict per citation and source reached. NULL when it is not the caller''s own answer.';
COMMENT ON FUNCTION app.answer_share_find(uuid, text, uuid, text) IS
  'The copy of a share the caller already made (live), under the advisory lock of its key: replays find it instead of posting again.';
COMMENT ON FUNCTION app.answer_share_record(uuid, text, uuid, text, text, uuid, integer, integer[], integer[]) IS
  'Writes the access-log line of a share (answer_shares) for the asker of the answer; ids of citations never appear, only their numbers and counts.';
