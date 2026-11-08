# Asana

Asana tasks, as each person's own sign-in.

## What it does

A bot can search tasks, read one with its comments, and (after approval) create a task, comment, or mark a task done or open. A work-app address lets Asana wake a bot when a task changes.

## Set up at Asana

1. In the Asana developer console make an app.
2. Add the redirect address `<site address>/api/me/connections/asana/callback`.
3. Give the client id and secret to manythreads at Settings, Connections, Apps.
4. For triggers: make a Work apps address for Asana at the channel's Integrations screen, then ask Asana to create a webhook for it. Asana makes its own secret during a handshake (its first call carries `X-Hook-Secret`); manythreads echoes it and keeps it sealed.

## Services, scopes and why

| Service | Scopes | Why |
|---|---|---|
| Tasks (read), ticked by default | `tasks:read`, `stories:read`, `workspaces:read`, `users:read` | search, read, comments |
| Tasks (create, comment, change status) | the four above, plus `tasks:write`, `stories:write` | the writes |

PKCE is used and tokens are renewed with a refresh token.

## Tools

`asana.search_tasks`, `asana.read_task`, `asana.create_task`, `asana.comment`, `asana.change_status`. Every write waits for approval. A task id is digits only. The card names the task by its id, and the tools tell the model to name it by its title.

## Triggers

`task_changed`, through a Work apps address. Asana signs with `X-Hook-Signature` (HMAC-SHA256 of the body), after the handshake. The event time must be within 7 days.

## Sync

None.

## Limits

Search is the workspace typeahead. With more than one workspace the tool asks which.

## Proved against the stand-in only

- The scope names, which come from Asana's granular scope list and are not checked against a real app. `projects:read` for listing a project, and whatever the typeahead search needs, may need adding.
- The webhook handshake against real Asana.
- Refresh behaviour.
