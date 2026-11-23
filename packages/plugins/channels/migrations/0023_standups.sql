-- Async stand-ups (P35-09, P18-04). A team lead turns a stand-up on for a channel: each member of the team is asked the questions in their conversation with
-- the stand-up bot once their own working day has started (their time zone and working hours, Monday to Friday from 09:00 when they set none), on the
-- stand-up's days; a person who is out of office or on Do not disturb then is skipped and not asked. Their next message in that conversation is the answer
-- (it wakes no bot run). One digest goes to the channel at the digest time, or as soon as everyone asked has answered: the answers, who was away, who did
-- not answer, and the pulse as counts only. The bot is then woken in the digest's thread to put each blocker on the board.

CREATE TABLE app.standups (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL UNIQUE REFERENCES app.channels (id) ON DELETE CASCADE,
  -- the bot that asks (a bot of the team; checked when it is set, and a bot that is gone or off simply asks nobody: no foreign key, the bots plugin may migrate after this one)
  bot_id       uuid NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  questions    text[] NOT NULL CHECK (cardinality(questions) BETWEEN 1 AND 5),
  pulse        boolean NOT NULL DEFAULT false,
  -- ISO weekdays, 1 = Monday … 7 = Sunday
  days         smallint[] NOT NULL DEFAULT '{1,2,3,4,5}' CHECK (cardinality(days) BETWEEN 1 AND 7 AND days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  -- the digest's time of day, in UTC, minutes after midnight
  digest_minute integer NOT NULL DEFAULT 720 CHECK (digest_minute BETWEEN 0 AND 1439),
  -- the UTC date of the last digest posted at its time (an early digest, when everyone has answered, also sets it)
  last_digest_on date,
  created_by   uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX standups_team ON app.standups (team_id);
COMMENT ON TABLE app.standups IS 'rls: team — C: a channel''s async stand-up (P18-04): read by whoever reads the channel; set by a lead of its team or a workspace admin; the asks and the digest are the system''s.';

CREATE TABLE app.standup_asks (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  standup_id          uuid NOT NULL REFERENCES app.standups (id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL,
  person_id           uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  -- the person's own date when they were asked
  local_date          date NOT NULL,
  conversation_id     uuid REFERENCES app.channels (id) ON DELETE SET NULL,
  question_message_id uuid REFERENCES app.messages (id) ON DELETE SET NULL,
  skipped             text CHECK (skipped IS NULL OR skipped IN ('out_of_office', 'do_not_disturb')),
  asked_at            timestamptz NOT NULL DEFAULT now(),
  answer              text CHECK (answer IS NULL OR length(answer) <= 4000),
  answer_message_id   uuid REFERENCES app.messages (id) ON DELETE SET NULL,
  answered_at         timestamptz,
  pulse               smallint CHECK (pulse IS NULL OR pulse BETWEEN 1 AND 5),
  digest_message_id   uuid REFERENCES app.messages (id) ON DELETE SET NULL,
  digested_at         timestamptz,
  UNIQUE (standup_id, person_id, local_date)
);
CREATE INDEX standup_asks_open ON app.standup_asks (conversation_id) WHERE answered_at IS NULL AND skipped IS NULL AND digested_at IS NULL;
CREATE INDEX standup_asks_undigested ON app.standup_asks (standup_id) WHERE digested_at IS NULL;
COMMENT ON TABLE app.standup_asks IS 'rls: person — P: one person''s stand-up of one day (asked, skipped, answered, digested): the person reads their own; the system writes them all (the asking job, the answer, the digest).';

ALTER TABLE app.standups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.standups FORCE ROW LEVEL SECURITY;
CREATE POLICY standups_select ON app.standups FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
CREATE POLICY standups_write ON app.standups FOR ALL
  USING ((SELECT app.is_system()) OR coalesce(app.lookup_channel_can(channel_id, 'manage'), false))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND coalesce(app.lookup_channel_can(channel_id, 'manage'), false)));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.standups TO manythreads_app;

ALTER TABLE app.standup_asks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.standup_asks FORCE ROW LEVEL SECURITY;
CREATE POLICY standup_asks_own ON app.standup_asks FOR SELECT USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY standup_asks_system ON app.standup_asks FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
GRANT SELECT ON app.standup_asks TO manythreads_app;
