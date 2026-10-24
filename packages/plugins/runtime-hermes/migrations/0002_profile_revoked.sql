-- runtime-hermes 0002: a person turning off a managed bot's token is remembered. Forward-only: never edit once applied.
--
-- When the pairing token the pod holds for a managed bot stops working (a lead revoked or rotated it on the bot's page), the platform no longer
-- quietly makes a new one: that would undo a decision a person took. The row is marked `revoked_at`, the bot has no profile in the pod's profile
-- set, and only an explicit re-enable (a lead or workspace admin) clears the mark and mints a fresh token.
ALTER TABLE app.hermes_profile_secrets ADD COLUMN revoked_at timestamptz;
