-- projects 0002: a repository address must be plain. Forward-only: never edit once applied.
--
-- 0001 let an address through that names the same place in two spellings ("https://host/a/../b", "https://host//a", "%2e%2e" segments) or carries an
-- "@" in the path; a prefix allowlist would then compare the text, not the place. The rule now (identical to isPlainRepoUrl in @manythreads/shared):
-- https, a host with no "/", "@", "?", "#", "%", "\" or space, then non-empty path segments with none of "@", "?", "#", "\" or space, and no segment
-- that is "." or ".." (also spelled with %2e). Refused, never rewritten.
--
-- NOT VALID: a row saved under the old rule is left alone (nothing is deployed with such a row; the pod controller refuses a non-plain address
-- anyway), while every insert and every update of a row is checked.

ALTER TABLE app.projects DROP CONSTRAINT projects_repo_url_check;
ALTER TABLE app.projects ADD CONSTRAINT projects_repo_url_check CHECK (
  length(repo_url) <= 300
  AND repo_url ~ '^https://[^/@?#[:space:]\\%]+(/[^/@?#[:space:]\\]+)*/?$'
  AND repo_url !~* '/(\.|%2e){1,2}(/|$)'
) NOT VALID;
