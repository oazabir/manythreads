-- projects 0006: a project says which git provider holds its repository (GitHub or GitLab, gitlab.com or a self-hosted installation) and whose name the
-- published commit carries. Forward-only: never edit once applied.
--
-- `provider` is decided by the host for github.com and gitlab.com and chosen by the lead for any other host. `commit_as` is `bot` (the project's bot account
-- is the author) or `requester` (the person who started the thread is the author; the bot account is always the committer). `push_user_id` is the bot
-- account's numeric id on the provider, kept for its no-reply address; it is not secret.

ALTER TABLE app.projects ADD COLUMN provider text NOT NULL DEFAULT 'github';
ALTER TABLE app.projects ADD CONSTRAINT projects_provider_known CHECK (provider IN ('github', 'gitlab'));
ALTER TABLE app.projects ADD COLUMN commit_as text NOT NULL DEFAULT 'bot';
ALTER TABLE app.projects ADD CONSTRAINT projects_commit_as_known CHECK (commit_as IN ('bot', 'requester'));
ALTER TABLE app.projects ADD COLUMN push_user_id text;
UPDATE app.projects SET provider = 'gitlab' WHERE repo_url ~* '^https://gitlab\.com/';
COMMENT ON COLUMN app.projects.provider IS 'github or gitlab: which API the project''s token is checked and used against.';
COMMENT ON COLUMN app.projects.commit_as IS 'bot: the bot account authors the published commit. requester: the person who started the thread does; the bot account is always the committer.';
COMMENT ON COLUMN app.projects.push_user_id IS 'The bot account''s numeric id on the provider, as the provider told when the token was checked (not secret).';
