-- projects 0005: one GitHub token for every project of a team under the same GitHub owner. Forward-only: never edit once applied.
--
-- `push_credential_shared` says only that this project uses the token the team keeps once for its owner (the owner is the first path part of the
-- repository address, so it is not stored). The token still lives only in the team pod's Secret, under one key for the owner; the project's own key there
-- holds the address and branch and a pointer to it. A project that has no token cannot be on a shared one.

ALTER TABLE app.projects ADD COLUMN push_credential_shared boolean NOT NULL DEFAULT false;
ALTER TABLE app.projects ADD CONSTRAINT projects_push_shared_needs_token CHECK (NOT push_credential_shared OR push_credential_set_at IS NOT NULL);
COMMENT ON COLUMN app.projects.push_credential_shared IS 'True when the project uses the token kept once for its GitHub owner (the "use for every project under this owner" choice). The token is never stored in the database.';

-- When the credential-check job last looked at the project's token, so the oldest-checked go first and a good token that stays good changes nothing else.
ALTER TABLE app.projects ADD COLUMN push_credential_checked_at timestamptz;
COMMENT ON COLUMN app.projects.push_credential_checked_at IS 'When the credential-check job last asked about this project''s token (null: not yet).';
