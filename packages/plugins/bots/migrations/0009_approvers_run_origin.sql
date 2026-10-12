-- bots 0009: what the approvals plugin needs from a bot and from a run (PLAN P5-20). Forward-only: never edit once applied.
--
--  * bots.approvers: the BOT.md `approvals.approvers` list as written (`role:on-call`, `person:<id>`), the loader's own projection of one
--    file like `triggers` and `native` (0005) and `model_aliases` (0008). An approval raised by a call that has no definition at hand (the
--    MCP gateway) reads it from here; empty means the team's leads and workspace admins decide. A bot loaded before this column carries
--    `{}` until its BOT.md next changes, which fails toward the leads, never toward a wider set.
--  * bot_runs.channel_id / reply_root_id: where the run answers (the channel and the message the reply hangs from). A run stopped for
--    an approval leaves its card in that thread; before this the run recorded only an existing thread, and a mention that opens one has none yet.

ALTER TABLE app.bots ADD COLUMN approvers text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN app.bots.approvers IS 'The BOT.md approvals.approvers list as written (role:<tag> or person:<id>); the approvals plugin reads it. The loader owns it.';

ALTER TABLE app.bot_runs ADD COLUMN channel_id uuid REFERENCES app.channels (id) ON DELETE SET NULL;
ALTER TABLE app.bot_runs ADD COLUMN reply_root_id uuid;
CREATE INDEX bot_runs_channel ON app.bot_runs (channel_id) WHERE channel_id IS NOT NULL;
COMMENT ON COLUMN app.bot_runs.channel_id IS 'The channel the run answers in, when it answers in one.';
COMMENT ON COLUMN app.bot_runs.reply_root_id IS 'The message the run''s reply hangs from (the thread root, or the message that opens the thread); no foreign key, a deleted message must not delete the run.';
