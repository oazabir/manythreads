-- tasks plugin 0018 (P25-10): the to-do list of a thread. Forward-only: never edit once applied.
--
-- A bot that works through a long request keeps one list for the whole thread (docs/plans/acp.md section 4.5): "read the code", "write the change", "run the tests",
-- each item waiting, working, done or blocked. The list is one row per thread. It is a different thing from a run's own plan (`run_view.plan`, one run) and from the
-- board (the team's cards): it is one request's view, and an item can name a card (`taskId`) and then follows it by itself.
--
-- Who reads it: whoever can read the thread's channel (the same rule as the thread's messages and a run's card). Who writes it: only the bot that made it, in one of its
-- own runs that answers in that thread, through the two doors below; and the platform, for items that name a card (the tasks plugin's own subscriber, as the system
-- role). A person cannot tick it: the board is where a person moves work.
--
-- `items` is a JSON array of at most 30 objects `{ id, text, status, taskId?, ownerId? }`, kept small by a check. The first save posts one message in the thread (the
-- tool does that, with `meta.todoRef`); `message_id` points to it so a later save rewrites it instead of posting another.

CREATE TABLE app.thread_todos (
  thread_root_id uuid PRIMARY KEY REFERENCES app.messages (id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL,
  team_id        uuid,
  channel_id     uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  message_id     uuid REFERENCES app.messages (id) ON DELETE SET NULL,
  bot_actor_id   uuid NOT NULL,
  title          text NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
  items          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 30 AND pg_column_size(items) <= 24000),
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX thread_todos_channel ON app.thread_todos (channel_id);
-- "which lists hold an item for this card": `items @> '[{"taskId": "..."}]'`
CREATE INDEX thread_todos_items ON app.thread_todos USING gin (items jsonb_path_ops);
COMMENT ON TABLE app.thread_todos IS 'rls: team — T: the to-do list of a thread (one row per thread: a title and at most 30 items), read by whoever can read the thread''s channel; written only by the doors below (the bot that made it) and by the tasks subscriber (system) for items that follow a card.';

ALTER TABLE app.thread_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.thread_todos FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_todos_select ON app.thread_todos FOR SELECT USING (
  (SELECT app.is_system())
  OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY thread_todos_system ON app.thread_todos FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.thread_todos TO manythreads_app;

-- The run a to-do call acts in: the calling bot's own live run, and the thread it answers in (the root of `reply_root_id`, not deleted, in a channel that is not
-- archived). Nothing is taken from an argument: a bot cannot name another thread or another run. No row when any condition fails.
CREATE FUNCTION app.todo_run_context() RETURNS TABLE (o_workspace_id uuid, o_team_id uuid, o_channel_id uuid, o_root_id uuid, o_actor_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT r.workspace_id, c.team_id, m.channel_id, coalesce(m.thread_root_id, m.id), bot.id
    FROM app.bot_runs r
    JOIN app.actors bot ON bot.kind = 'bot' AND bot.ref_id = r.bot_id AND bot.workspace_id = r.workspace_id
    JOIN app.messages m ON m.id = r.reply_root_id AND m.workspace_id = r.workspace_id AND m.deleted_at IS NULL
    JOIN app.channels c ON c.id = m.channel_id AND c.archived_at IS NULL
   WHERE r.id = app.run_id() AND r.status = 'running' AND r.ended_at IS NULL AND bot.id = app.actor()
$$;

-- Make or replace the list of the run's thread. `p_message_id` is the message that shows it (the tool posts it first): it must be the bot's own message in this thread
-- that carries `meta.todoRef` for this thread. Outcomes: `saved`, `no_run` (no live run answering in a thread), `not_owner` (another bot made the list), `bad_message`,
-- `invalid` (not an array of at most 30).
CREATE FUNCTION app.todo_write(p_title text, p_items jsonb, p_message_id uuid)
  RETURNS TABLE (o_outcome text, o_workspace_id uuid, o_team_id uuid, o_channel_id uuid, o_root_id uuid, o_message_id uuid, o_version integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ctx record;
  v_row app.thread_todos%ROWTYPE;
BEGIN
  SELECT * INTO v_ctx FROM app.todo_run_context();
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_run'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 30 THEN
    RETURN QUERY SELECT 'invalid'::text, v_ctx.o_workspace_id, v_ctx.o_team_id, v_ctx.o_channel_id, v_ctx.o_root_id, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  SELECT * INTO v_row FROM app.thread_todos t WHERE t.thread_root_id = v_ctx.o_root_id FOR UPDATE;
  IF FOUND AND v_row.bot_actor_id <> v_ctx.o_actor_id THEN
    RETURN QUERY SELECT 'not_owner'::text, v_ctx.o_workspace_id, v_ctx.o_team_id, v_ctx.o_channel_id, v_ctx.o_root_id, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  IF p_message_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.messages m
        WHERE m.id = p_message_id AND m.channel_id = v_ctx.o_channel_id AND m.author_id = v_ctx.o_actor_id AND m.deleted_at IS NULL
          AND coalesce(m.thread_root_id, m.id) = v_ctx.o_root_id AND m.meta ->> 'todoRef' = v_ctx.o_root_id::text) THEN
    RETURN QUERY SELECT 'bad_message'::text, v_ctx.o_workspace_id, v_ctx.o_team_id, v_ctx.o_channel_id, v_ctx.o_root_id, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  INSERT INTO app.thread_todos AS t (thread_root_id, workspace_id, team_id, channel_id, message_id, bot_actor_id, title, items)
  VALUES (v_ctx.o_root_id, v_ctx.o_workspace_id, v_ctx.o_team_id, v_ctx.o_channel_id, p_message_id, v_ctx.o_actor_id, coalesce(p_title, ''), p_items)
  ON CONFLICT (thread_root_id) DO UPDATE
     SET title = excluded.title, items = excluded.items, message_id = coalesce(excluded.message_id, t.message_id), version = t.version + 1, updated_at = now()
  RETURNING t.* INTO v_row;
  RETURN QUERY SELECT 'saved'::text, v_row.workspace_id, v_row.team_id, v_row.channel_id, v_row.thread_root_id, v_row.message_id, v_row.version;
END
$$;

-- Change the status of one item of the run's thread list, in one statement under the row lock (two calls at once do not lose each other). Outcomes: `saved`,
-- `no_run`, `no_list` (this thread has no list), `not_owner`, `no_item`, `invalid` (a status that is not one of the four).
CREATE FUNCTION app.todo_set_status(p_item_id text, p_status text)
  RETURNS TABLE (o_outcome text, o_workspace_id uuid, o_team_id uuid, o_channel_id uuid, o_root_id uuid, o_message_id uuid, o_version integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_ctx record;
  v_row app.thread_todos%ROWTYPE;
BEGIN
  SELECT * INTO v_ctx FROM app.todo_run_context();
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_run'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('waiting', 'working', 'done', 'blocked') THEN
    RETURN QUERY SELECT 'invalid'::text, v_ctx.o_workspace_id, v_ctx.o_team_id, v_ctx.o_channel_id, v_ctx.o_root_id, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  SELECT * INTO v_row FROM app.thread_todos t WHERE t.thread_root_id = v_ctx.o_root_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_list'::text, v_ctx.o_workspace_id, v_ctx.o_team_id, v_ctx.o_channel_id, v_ctx.o_root_id, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  IF v_row.bot_actor_id <> v_ctx.o_actor_id THEN
    RETURN QUERY SELECT 'not_owner'::text, v_ctx.o_workspace_id, v_ctx.o_team_id, v_ctx.o_channel_id, v_ctx.o_root_id, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  IF NOT jsonb_path_exists(v_row.items, '$[*] ? (@.id == $id)', jsonb_build_object('id', p_item_id)) THEN
    RETURN QUERY SELECT 'no_item'::text, v_ctx.o_workspace_id, v_ctx.o_team_id, v_ctx.o_channel_id, v_ctx.o_root_id, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  UPDATE app.thread_todos t
     SET items = (SELECT jsonb_agg(CASE WHEN e.item ->> 'id' = p_item_id THEN jsonb_set(e.item, '{status}', to_jsonb(p_status)) ELSE e.item END ORDER BY e.ord)
                    FROM jsonb_array_elements(t.items) WITH ORDINALITY AS e(item, ord)),
         version = t.version + 1, updated_at = now()
   WHERE t.thread_root_id = v_ctx.o_root_id
  RETURNING t.* INTO v_row;
  RETURN QUERY SELECT 'saved'::text, v_row.workspace_id, v_row.team_id, v_row.channel_id, v_row.thread_root_id, v_row.message_id, v_row.version;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.todo_run_context() OWNER TO manythreads_system;
ALTER FUNCTION app.todo_write(text, jsonb, uuid) OWNER TO manythreads_system;
ALTER FUNCTION app.todo_set_status(text, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.todo_run_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.todo_write(text, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.todo_set_status(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.todo_run_context() TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.todo_write(text, jsonb, uuid) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.todo_set_status(text, text) TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.todo_run_context() IS 'The calling bot''s live run and the thread it answers in; no row when any condition fails. Nothing comes from an argument.';
COMMENT ON FUNCTION app.todo_write(text, jsonb, uuid) IS 'Makes or replaces the to-do list of the run''s thread; only the bot that made it may replace it.';
COMMENT ON FUNCTION app.todo_set_status(text, text) IS 'Changes the status of one item of the run''s thread list, under the row lock; only the bot that made the list.';
