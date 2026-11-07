-- runtime-hermes 0005 (P20-LV): the workspace Brain can have a managed profile. Forward-only: never edit once applied.
--
-- `hermes_profile_secrets.team_id` was NOT NULL, but the workspace Brain (bots 0027) belongs to no team, so the credentials of its profile could not be stored. The column
-- stays filled for every team bot; it is empty only for a bot of scope `workspace`.
ALTER TABLE app.hermes_profile_secrets ALTER COLUMN team_id DROP NOT NULL;
