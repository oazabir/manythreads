-- runtime-hermes 0006 (P25-06): what a run did, kept so a card can be opened after the fact. Forward-only: never edit once applied.
--
-- A run of a bot used to leave a row in `bot_runs` and a line in the log, and nothing a person could look at later. Now it leaves two things:
--
--   * `run_activity`: one short line per step, per helper, per change of the plan, per stretch of thinking and per question to a person, in order. A step is its
--     kind, one line of title and at most five paths (the run job redacts them again before they are written); never a tool's input or output, a file's content or
--     the agent's reasoning. A run keeps at most 2000 lines; after that the steps are only counted in `run_view`.
--   * `run_view`: one row per run with the folded state a card draws (what it is doing now, the counts, the plan, the helpers, when it began and ended, who stopped it).
--
-- Who reads them is decided by who can read the run's CHANNEL, not by the team-wide rule of `bot_runs`: a run in a private channel would otherwise leak its titles and
-- paths to team members who cannot read that channel. A run in a person's own conversation is read by its asker alone (as `bot_runs`). A bot reads its own run. Both
-- tables are written only by the run job, as the system role.
--
-- Both tables go with their run (ON DELETE CASCADE from `bot_runs`), so the run-log retention of the retention plugin prunes them with it and no second clock is kept.
--
-- Each row carries the channel (and for a conversation, the asker) of its run, so the policy is one hoisted set per statement (kernel 0011) and never a join.

CREATE TABLE app.run_view (
  run_id            uuid PRIMARY KEY REFERENCES app.bot_runs (id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL,
  team_id           uuid NOT NULL,
  channel_id        uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  thread_root_id    uuid REFERENCES app.messages (id) ON DELETE CASCADE,
  bot_id            uuid NOT NULL,
  bot_actor_id      uuid,
  bot_name          text NOT NULL CHECK (char_length(bot_name) <= 200),
  asker_id          uuid,
  conversation      boolean NOT NULL DEFAULT false,
  state             text NOT NULL CHECK (state IN ('starting', 'working', 'waiting', 'stopping', 'done', 'failed', 'stopped')),
  now_step          jsonb CHECK (now_step IS NULL OR (jsonb_typeof(now_step) = 'object' AND pg_column_size(now_step) <= 2500)),
  counts            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object' AND pg_column_size(counts) <= 500),
  helpers           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(helpers) = 'array' AND pg_column_size(helpers) <= 6000),
  plan              jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(plan) = 'array' AND pg_column_size(plan) <= 16000),
  plan_version      integer NOT NULL DEFAULT 0 CHECK (plan_version >= 0),
  last_seq          integer NOT NULL DEFAULT -1 CHECK (last_seq >= -1),
  stop_reason       text CHECK (stop_reason IS NULL OR char_length(stop_reason) <= 60),
  cost              jsonb CHECK (cost IS NULL OR (jsonb_typeof(cost) = 'object' AND pg_column_size(cost) <= 200)),
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz,
  -- Stop (P25-08): asked for by a person; the run job sees it within a few seconds on any replica
  stop_requested_at timestamptz,
  stopped_by_actor  uuid,
  stopped_by_name   text CHECK (stopped_by_name IS NULL OR char_length(stopped_by_name) <= 200),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_view_ended_after_started CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX run_view_thread ON app.run_view (thread_root_id, started_at) WHERE thread_root_id IS NOT NULL;
CREATE INDEX run_view_channel ON app.run_view (channel_id);
-- the runs that are still going: the stale sweep (by the last sign of life) and the "who is working in this channel" read
CREATE INDEX run_view_active_updated ON app.run_view (updated_at) WHERE ended_at IS NULL;
CREATE INDEX run_view_active_channel ON app.run_view (channel_id, started_at) WHERE ended_at IS NULL;
COMMENT ON TABLE app.run_view IS 'rls: team — T: the folded state of a run (now, counts, plan, helpers, who stopped it), read by whoever can read the run''s channel (a conversation run: its asker alone; a bot: its own run); written only by the run job (system).';

CREATE TABLE app.run_activity (
  run_id         uuid NOT NULL REFERENCES app.bot_runs (id) ON DELETE CASCADE,
  seq            integer NOT NULL CHECK (seq >= 0),
  at             timestamptz NOT NULL DEFAULT now(),
  kind           text NOT NULL CHECK (kind IN ('tool', 'tool_result', 'agent', 'plan', 'thinking', 'approval')),
  payload        jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 16000),
  channel_id     uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  thread_root_id uuid,
  asker_id       uuid,
  conversation   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX run_activity_channel ON app.run_activity (channel_id);
CREATE INDEX run_activity_at ON app.run_activity USING brin (at);
COMMENT ON TABLE app.run_activity IS 'rls: team — T: the lines of a run''s work (steps, helpers, plan, thinking time, questions; titles and paths redacted, never a tool''s input or output), read by whoever can read the run''s channel (a conversation run: its asker alone; a bot: its own run); written only by the run job (system).';

ALTER TABLE app.run_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_view FORCE ROW LEVEL SECURITY;
-- A bot reads only the run it is running (`run_id`); the channel branches are a person's (a bot's `visible_channel_ids` holds the public channels of its team, which
-- would show it every run there). The asker of a conversation run reads it only while they still can read that conversation.
CREATE POLICY run_view_select ON app.run_view FOR SELECT USING (
  (SELECT app.is_system())
  OR run_id = (SELECT app.run_id())
  OR ((SELECT app.person_id()) IS NOT NULL AND (
        (conversation AND asker_id = (SELECT app.actor()) AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]))
     OR (NOT conversation AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])))));
CREATE POLICY run_view_system ON app.run_view FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.run_view TO manythreads_app;

ALTER TABLE app.run_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY run_activity_select ON app.run_activity FOR SELECT USING (
  (SELECT app.is_system())
  OR run_id = (SELECT app.run_id())
  OR ((SELECT app.person_id()) IS NOT NULL AND (
        (conversation AND asker_id = (SELECT app.actor()) AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]))
     OR (NOT conversation AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])))));
CREATE POLICY run_activity_system ON app.run_activity FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.run_activity TO manythreads_app;
