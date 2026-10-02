-- 0010_person_emails_verified_unique: an address is exclusive to one person only once it is VERIFIED, and only inside its
-- workspace. The old global unique index on lower(email) let anyone squat an address by adding it unverified (blocking
-- the real owner from verifying it) and made two workspaces on one instance fight over the same address.
--   * unverified rows may repeat across people (nobody has proved the address yet);
--   * a verified address belongs to one person per workspace (the verification itself is system-only, so this cannot be forced);
--   * a person lists an address once, so "add it again" stays a no-op (ON CONFLICT DO NOTHING) as before.
DROP INDEX app.person_emails_email;
CREATE UNIQUE INDEX person_emails_verified ON app.person_emails (workspace_id, lower(email)) WHERE verified_at IS NOT NULL;
CREATE UNIQUE INDEX person_emails_person_email ON app.person_emails (person_id, lower(email));
-- Lookups by address (sign-in, invitations) use lower(email) without a person; keep them indexed.
CREATE INDEX person_emails_lookup ON app.person_emails (lower(email));
