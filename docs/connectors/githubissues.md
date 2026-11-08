# GitHub Issues

Issues (and pull-request events) in the repositories a person can open.

## What it does

A bot can search and read issues, and (after approval) open one, comment, close or reopen. A work-app address lets GitHub wake a bot when an issue is opened or a pull request changes. This is the person's own sign-in, separate from the team's GitHub connection used for code.

## Set up at GitHub

1. In GitHub, Settings, Developer settings, make an OAuth app.
2. Add the callback `<site address>/api/me/connections/githubissues/callback`.
3. Give the client id and secret to manythreads at Settings, Connections, Apps.
4. For triggers: make a Work apps address for GitHub at the channel's Integrations screen, and in the repository add a webhook with that address, content type JSON, and the signing secret manythreads shows once.

## Services, scopes and why

One service, GitHub Issues, with the scope `repo`. GitHub cannot grant read access alone, so this sign-in can write, and every tool that writes still waits for approval. The sign-in uses PKCE. GitHub tokens are not renewed; a rejected token means "connect again". The provider id has no underscore (`githubissues`) because a connection's slug is its provider id.

## Tools

`github_issues.search_issues`, `github_issues.read_issue`, `github_issues.create_issue`, `github_issues.comment`, `github_issues.change_status`. No tool closes a pull request. A repository is written `owner/name`; a name that is only dots, or a bare integer, is refused.

## Triggers

`issue_opened` and `pull_request_changed`, through a Work apps address. GitHub signs with `X-Hub-Signature-256: sha256=<hex>`. The event time must be within 7 days.

## Sync

None.

## Limits

Words in a search lose colons, so they cannot become search qualifiers. An error answer never quotes an issue, comment or title.

## Proved against the stand-in only

- The consent screen and PKCE with a real OAuth app.
- A real webhook (the signature is also checked against GitHub's documented test vector).
- Private repositories and organisation approval rules for OAuth apps.
