# Jira

Jira Cloud issues, as each person's own sign-in (Atlassian OAuth 3LO).

## What it does

A bot can search issues, read one with its comments, and (after approval) create an issue, comment, or move an issue to another status. A work-app address lets Jira wake a bot when an issue changes.

## Set up at Jira

1. At developer.atlassian.com make an OAuth 2.0 (3LO) app.
2. Add the redirect address `<site address>/api/me/connections/jira/callback`.
3. Add the permissions `read:jira-work` and `write:jira-work` (Jira API), and give the client id and secret to manythreads at Settings, Connections, Apps.
4. For triggers: at the channel's Integrations screen, tab Work apps, make an address for Jira and copy it. In Jira, add a webhook that points to it and signs calls with the secret shown once by manythreads.

## Services, scopes and why

| Service | Scopes | Why |
|---|---|---|
| Issues (read), ticked by default | `read:jira-work` | search and read |
| Issues (create, comment, change status) | `read:jira-work`, `write:jira-work` | the writes |

The sign-in also asks for `offline_access` (a refresh token) and `read:me`. Consent always shows (`prompt=consent`). Adding a service asks again with the earlier scopes included.

## Tools

`jira.search_issues`, `jira.read_issue`, `jira.create_issue`, `jira.comment`, `jira.change_status`. Every write waits for approval. The card leads with the tracker, the act and the target (`Jira: comment on PROJ-7`), then the text from its start, cut at 280 characters with its full length beside it.

## Triggers

`issue_changed`, through a Work apps address. The bot's BOT.md has `- type: webhook` with `connection:` equal to the address's short name and, if wanted, `event:`. Jira signs with `X-Hub-Signature: sha256=<hex>`. A call is accepted if the event time is within 7 days.

## Sync

None. Nothing is copied. The two-way card and issue mirror is not built.

## Limits

Of the sites the sign-in can reach, only those with a Jira work scope count, and the one with the lowest id is used every time (the card names it). An issue id must look like `PROJ-123`. A step is chosen by the status it ends in, never by its own name; of several steps to one status the lowest id runs. Words in a search lose query operators and quotes. Descriptions and comments are converted between plain text and Atlassian's document format without cutting a character.

## Proved against the stand-in only

- Atlassian's consent screen, the site list and the refresh token rotation.
- That `read:jira-work` and `write:jira-work` give every call the tools make.
- Step names and ids on a real project with a custom workflow.
- A real Jira webhook (the stand-in signs the way the documentation says).
