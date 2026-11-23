-- P18-09 (P35-06): a channel a team lead marks as a help channel. Its composer suggests an earlier answer (a knowledge passage, a past thread the asker may
-- read) while a question is being written; nothing is posted for the asker. Only a channel (not a direct message or a bot conversation) can be one.
ALTER TABLE app.channels ADD COLUMN help boolean NOT NULL DEFAULT false;
ALTER TABLE app.channels ADD CONSTRAINT channels_help_kind CHECK (NOT help OR kind = 'channel');
COMMENT ON COLUMN app.channels.help IS 'A help channel (P18-09): the composer suggests earlier answers before a question is posted. Set by a team lead or workspace admin.';
