-- bot-runners 0012: what an enrolled server's bridge says about its sign-ins, and a short claim on a runner whose sign-in scope is being switched (PLAN.md P35-10b,
-- docs/plans/per-team-sign-in.md sections 7 and 8). Forward-only and additive: a server one version back never reads or writes these columns.
--
--   bot_servers.team_users       the bridge said, in its last hello or at enrolment, that each team's runs are a Unix user of its own there (P26-22). Only then may a Claude Code or
--                                Codex runner on it sign in per team: on a one-user server every team could read every other team's sign-in folder.
--   bot_servers.signin_scopes    what the bridge last said it keeps, per agent: {"claude": "shared"|"per_team"|"unreadable", "codex": ...} and the teams whose own sign-in folder may be
--                                left while the agent has one sign-in ({"stale": {"claude": [slug]}}). The site compares it with each runner's sign_in_scope and says so when they
--                                differ; it never flips the column on its own. No account and no secret.
--   bot_runners.scope_switch_at  set while an admin's switch of who signs in waits for the bridge (a short transaction claims it; the bridge is asked outside any transaction; another
--                                short one writes the result and clears it). A claim older than ten minutes counts as lost.
ALTER TABLE app.bot_servers
  ADD COLUMN team_users boolean NOT NULL DEFAULT false,
  ADD COLUMN signin_scopes jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app.bot_runners ADD COLUMN scope_switch_at timestamptz;

COMMENT ON COLUMN app.bot_servers.team_users IS 'The server''s bridge said each team runs as a Unix user of its own there (P26-22), in its last hello or at enrolment. Gates the per-team sign-in of its runners (P35-10b). Admin-only.';
COMMENT ON COLUMN app.bot_servers.signin_scopes IS 'Who signs each agent in, as the server''s bridge last said it keeps it, and teams whose own sign-in folder may be left (P35-10b). Compared with bot_runners.sign_in_scope; never written into it. Admin-only.';
COMMENT ON COLUMN app.bot_runners.scope_switch_at IS 'Set while a switch of who signs in waits for the server''s bridge (P35-10b); older than ten minutes counts as lost. Admin-only.';
