-- projects 0004: who the publishing token belongs to, and what GitHub said about it when it was saved. Forward-only: never edit once applied.
--
-- The username is not a secret and neither are the expiry date or the status; the token still lives only in the team pod's Secret.
-- `push_credential_status` is `ok` after a good check, and `needs_replacing` once GitHub refuses the token later (a 401): the project then stops
-- trying until a new token is saved.

ALTER TABLE app.projects ADD COLUMN push_username text;
ALTER TABLE app.projects ADD COLUMN push_credential_expires_at timestamptz;
ALTER TABLE app.projects ADD COLUMN push_credential_status text;
ALTER TABLE app.projects ADD CONSTRAINT projects_push_credential_status_check CHECK (push_credential_status IS NULL OR push_credential_status IN ('ok', 'needs_replacing'));
ALTER TABLE app.projects ADD CONSTRAINT projects_push_username_check CHECK (push_username IS NULL OR push_username ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$');
COMMENT ON COLUMN app.projects.push_username IS 'The GitHub login the publishing token belongs to (checked against GitHub when it was saved). Not a secret.';
COMMENT ON COLUMN app.projects.push_credential_expires_at IS 'When GitHub says the token expires (null: no expiry, or unknown).';
COMMENT ON COLUMN app.projects.push_credential_status IS 'ok, or needs_replacing once GitHub refused the token (null: no token).';
