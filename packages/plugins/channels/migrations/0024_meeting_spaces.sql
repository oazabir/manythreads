-- P36-03: a meeting space, a channel of kind `meeting` (docs/plans/meetings-without-a-channel.md). It belongs to no team, so its people may come from any team
-- of the workspace; it is private and its members are the person who made it and the people invited; its title is its `purpose`. A person sees it through
-- the members path of app.visible_channel_ids, which already admits a team-less channel; a bot and a guest never do. The meetings plugin makes it.
ALTER TABLE app.channels DROP CONSTRAINT channels_kind_check;
ALTER TABLE app.channels ADD CONSTRAINT channels_kind_check CHECK (kind IN ('channel', 'dm', 'bot_conversation', 'meeting'));
ALTER TABLE app.channels ADD CONSTRAINT channels_meeting_shape CHECK (kind <> 'meeting' OR (private AND team_id IS NULL AND dm_key IS NULL AND bot_id IS NULL));
