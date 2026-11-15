-- bot-runners 0009: when a key rotation began (PLAN.md P26-12 review, M3). Forward-only and additive: a server one version back never reads or writes the column.
--
-- A second `rotate` while the first is still waiting for the bridge's `rotated` replaced the pending hash, so a bridge that had already stored the first key presented a key that
-- matched neither hash and was locked out. A rotation now refuses to start while another is pending and younger than 15 minutes; after that the old one is taken to be lost (the bridge
-- never got the frame) and may be replaced.
ALTER TABLE app.bot_servers ADD COLUMN pending_key_at timestamptz;
COMMENT ON COLUMN app.bot_servers.pending_key_at IS 'When pending_key_hash was set; null when there is no pending key. A rotation may replace a pending key only when it is older than 15 minutes.';
