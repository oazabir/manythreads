# Linear

Linear issues, as each person's own sign-in.

## What it does

A bot can search issues, read one with its comments, and (after approval) create an issue, comment, or change its status. A work-app address lets Linear wake a bot when an issue changes.

## Set up at Linear

1. In Linear, Settings, API, make an OAuth application.
2. Add the redirect address `<site address>/api/me/connections/linear/callback`.
3. Give the client id and secret to manythreads at Settings, Connections, Apps.
4. For triggers: make a Work apps address for Linear at the channel's Integrations screen. In Linear, add a webhook with that address and the signing secret manythreads shows once.

## Services, scopes and why

| Service | Scopes | Why |
|---|---|---|
| Issues (read), ticked by default | `read` | search and read |
| Issues (create, comment, change status) | `read`, `write` | the writes |

## Tools

`linear.search_issues`, `linear.read_issue`, `linear.create_issue`, `linear.comment`, `linear.change_status`. Every write waits for approval. The card names the issue by its id (`ENG-7`), and the tools tell the model to name it by its title.

## Triggers

`issue_changed`, through a Work apps address. Linear signs with `Linear-Signature: <hex>` (HMAC-SHA256 of the body), and the body's `webhookTimestamp` must be within 60 seconds.

## Sync

None.

## Limits

Values travel as GraphQL variables, so a word can never become part of the query. Failures are read from the error's `extensions` (type and code): a lost sign-in renews the token once and tries again (then says to connect again), a rate limit says to slow down, a permission failure is 403, and only a missing record is "not found". No word of Linear's message is passed on.

## Proved against the stand-in only

- Linear's consent screen and refresh behaviour.
- The exact `extensions` Linear sends for a lost sign-in and for a missing record (read in the likeliest shapes; they need one real run).
- A real Linear webhook delivery and its 60-second window.
