-- workshop 0002: the Workshop tab of a bot (PLAN P7-05, P7-06). Forward-only: never edit once applied.
--
-- A Workshop session is one person's conversation about ONE bot, in one of three modes: Build (changes become proposals), Rehearse (the bot answers in a sandbox where every write is
-- held back) or Live (questions about the bot's real runs). It is the person's own: nobody else reads it, not a lead and not an admin, because the person may say anything and a
-- rehearsal transcript holds what the bot would have answered. `entries` is what the person sees (their messages, the answers, the tool steps with the "not really done" badge, the
-- proposals filed); `history` is the helper's own conversation, kept so the next message continues it, and the API never returns it. `usage` counts the model calls and tokens this
-- conversation cost; its lines in the spend ledger (`llm_spend`) carry the session id, prefixed `rehearsal:` for a rehearsal.
--
-- The person reads, starts and continues their own sessions. The model turn runs as a background job under the system role (it works while no request is open); it writes only a
-- session that is still `working` and still on the turn it was queued for, so a person who ended the conversation meanwhile is never overwritten.
CREATE TABLE app.workshop_sessions (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  bot_id        uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  bot_slug      text NOT NULL CHECK (char_length(bot_slug) BETWEEN 1 AND 100),
  owner_id      uuid NOT NULL REFERENCES app.actors (id) ON DELETE CASCADE,
  mode          text NOT NULL CHECK (mode IN ('build', 'rehearse', 'live')),
  status        text NOT NULL DEFAULT 'ready' CHECK (status IN ('working', 'ready', 'ended', 'failed', 'cancelled')),
  title         text NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
  entries       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(entries) = 'array' AND pg_column_size(entries) <= 600000),
  history       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array' AND pg_column_size(history) <= 400000),
  usage         jsonb NOT NULL DEFAULT '{"calls":0,"promptTokens":0,"completionTokens":0}'::jsonb CHECK (jsonb_typeof(usage) = 'object'),
  message       text CHECK (message IS NULL OR char_length(message) <= 2000),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  turn          integer NOT NULL DEFAULT 0 CHECK (turn >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workshop_sessions_workspace ON app.workshop_sessions (workspace_id);
CREATE INDEX workshop_sessions_team ON app.workshop_sessions (team_id);
CREATE INDEX workshop_sessions_bot ON app.workshop_sessions (bot_id, owner_id, created_at DESC);
CREATE INDEX workshop_sessions_owner ON app.workshop_sessions (owner_id, created_at DESC);
COMMENT ON TABLE app.workshop_sessions IS 'rls: person — P: one person''s Workshop conversation about a bot (Build, Rehearse or Live): their messages, the answers, the tool steps and the proposals filed; nobody else reads or changes it, not even an admin; the model turn runs as the system role.';

ALTER TABLE app.workshop_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workshop_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY workshop_sessions_select ON app.workshop_sessions FOR SELECT
  USING ((SELECT app.is_system()) OR owner_id = (SELECT app.actor()));
CREATE POLICY workshop_sessions_insert ON app.workshop_sessions FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND owner_id = (SELECT app.actor())));
CREATE POLICY workshop_sessions_update ON app.workshop_sessions FOR UPDATE
  USING ((SELECT app.is_system()) OR owner_id = (SELECT app.actor()))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND owner_id = (SELECT app.actor())));
CREATE POLICY workshop_sessions_delete ON app.workshop_sessions FOR DELETE USING ((SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE ON app.workshop_sessions TO manythreads_app;
