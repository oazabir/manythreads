# channels

Channel groups, channels, membership, messages, reactions, mentions and entity links parsed from a message, presence and typing, threads (counted here; read,
followed and listed by the [threads plugin](./threads.md)) and the live pushes (SPEC section 6.1 and 5.3, PLAN P3-01, P3-02, P3-05, P3-07).
Code: `packages/plugins/channels`. Schemas: `packages/shared/src/{entities/channel, entities/message*,api/channels,events/channel.*}`. Direct messages
([direct-messages.md](./direct-messages.md)) are channels of kind `dm`; attachments, notifications and search build on these tables in other tasks.

## Who sees what

The one rule is `app.visible_channel_ids(permission)` (migration `0001`), a `SECURITY DEFINER` function that returns the `uuid[]` of channels the
**caller** may read (`'read'`) or write in (`'post'`). Every read policy probes it once per statement (the hoisted idiom of
[README.md](./README.md#visibility-sets-hoist-a-uuid-of-ids-the-caller-may-see)): an unscoped `count(*)` over 300,000 messages takes 40 to 70 ms.

| Channel | Who reads it | Who posts in it |
|---|---|---|
| public (`private = false`) of a team | members of the team; workspace owner and admins (every team) | the same, unless the channel is archived |
| private, DM, bot conversation | people with a `channel_members` row; **not** workspace admins | the same, unless archived |
| any channel with an `acl_entries` grant (`resource_type 'channel'`, person, team or role) | the grantee at `read` or more | only a grant at `post` or more: Lena has `read`, so she reads and cannot post |

A guest (workspace role `guest`) never gets access from a membership row or a team, only from a grant: take the grant away and the channel is gone.
A suspended person sees nothing. The system role bypasses everything through `app.is_system()`.

- `app.channel_can(channel, 'read'|'post'|'manage')` is the single-row check (routes, UPDATE policies). `manage` is "lead of the channel's team or workspace admin", for team
  channels only. `'channel'` is also registered in `app.resource_kinds` so ACL entries may name a channel, but **do not use `app.can('channel', ...)` to decide anything**:
  `lookup_can` gives a workspace admin every resource, private channels included.
- `app.channel_audience(channel)` is the same rule from the channel's side: the person ids who can read it now. It feeds the live pushes; a test proves it equals the set of
  people whose `visible_channel_ids` holds the channel, for every persona and every kind of channel. It answers nothing to a caller who cannot read the channel.
- Writes to `channel_members` go only through `app.channels_join`, `app.channels_add_member`, `app.channels_remove_member` (definer functions; each checks the caller with
  `app.lookup_*`, the target person, same workspace, terminal states: an archived channel, a DM, a guest). A lead or workspace admin adds anyone **on the channel's team**; an
  admin who is not on the team of a private channel cannot read it and has to be put on the team first (a visible roster change). A DM cannot be left.
- Hidden and missing look the same: every refusal on an unseen channel is **403**, never 404.
- `app.lookup_can_team()` answers NULL (not false) for a non-member: every definer-side check wraps it in `coalesce(..., false)` (MISTAKES P3-05).

## Tables (migrations `0001_channels.sql`, `0002_messages.sql`, `0003_mentions_presence_typing.sql`)

| Table | Notes |
|---|---|
| `channel_groups` | `(team_id, name)` unique; sidebar order by `position`. T. |
| `channels` | `kind` `channel`/`dm`/`bot_conversation`; `private`; unique `(team_id, name) WHERE kind='channel'` and `(workspace_id, dm_key) WHERE kind='dm'`. Names are stored without the `#`. Team, kind, privacy and owner never change (trigger); DMs and bot conversations are not writable through the policy. |
| `channel_members` | PK `(channel_id, person_id)`, `muted`. Read-only for the app role. |
| `messages` | `(channel_id, id DESC) INCLUDE (author_id, thread_root_id)`, partial `(thread_root_id, id)`, GIN trigram `body_plain`, `(author_id)`. Body 1 to 40,000 characters. Edit changes only `body`/`body_plain`/`edited_at` (author, not once deleted); delete sets `deleted_at` once and empties `body_plain` (author or team lead); nothing else changes (trigger). |
| `message_reactions`, `message_mentions` | `channel_id` is copied from the message by a trigger so the policy can probe the visibility set and a caller cannot claim another channel. |
| `threads` | one row per root message, created and counted **in the same statement** as the reply by a trigger (`reply_count` of live replies, `last_reply_at`, `title` = first 120 characters of the root). The first reply makes the replier and the root's author follow the thread; later replies make only their own replier follow (so a root author who unfollowed stays out). |
| `thread_follows` | P: own rows only, for a message the person can read. The membership of a thread; `read_state.followed` is its mirror, kept by a trigger (see [threads.md](./threads.md#following-one-source-of-truth)). |
| `presence` | `(person_id PK, workspace_id, status 'online'/'away', seen_at)`. **UNLOGGED**. WR: members read everyone of the workspace, a guest only themself; a person writes only their own row. |
| `typing` | `(channel_id, person_id) PK, expires_at`. **UNLOGGED**. C: readable with the channel; a person writes only their own row, in a channel they can post in; anyone who reads the channel may delete rows that have expired. |
| `channel_template_syncs` | S: teams whose template channels were created (see below). |

Every table has `ENABLE` and `FORCE ROW LEVEL SECURITY`, an `rls:` comment, and passes `findRlsViolations` and `findPerRowPolicyCalls` (`pnpm test:rls`).

## Routes

| Method and path | What it does |
|---|---|
| `GET /api/teams/:slug/channels` | The sidebar directory, shape `NavChannelDirectory`: groups by position with the channels the caller can see (archived ones left out), `unread` from the read state. A team the caller cannot see, or an unknown slug, is `{ groups: [] }` (200, so the shell's 404 feature detection stays on). A **guest** gets only their granted channels in one group "Channels", whatever the slug. Also creates a seeded team's template channels once (below). |
| `POST /api/teams/:slug/channels` `{ name, purpose?, private?, groupId? }` | Team lead or workspace admin. A leading `#` is accepted. Without `groupId` the channel joins the team's group "Channels" when there is one. A private channel starts with its creator as its only member. 409 for a taken name. |
| `POST /api/teams/:slug/channel-groups` `{ name }` | Lead or admin; the same name again returns the group (`created: false`). |
| `GET /api/channels/:channelId` | The channel plus `isMember`, `canPost`, `canManage` (the composer hides when `canPost` is false). |
| `PATCH /api/channels/:channelId` `{ name?, purpose?, groupId? }`, `POST .../archive`, `POST .../unarchive` | Lead or admin who can see the channel. An archived channel is read-only (409 on changes and posts). |
| `POST .../join`, `POST .../leave` | A workspace member joins a public channel or leaves one (a DM cannot be left). |
| `GET .../members`, `POST .../members` `{ personId }`, `DELETE .../members/:personId` | List (not for guests), add (lead or admin; the person must be on the team), remove (lead or admin, or yourself). |
| `GET /api/channels/:channelId/messages?before=&limit=&threadRootId=` | Newest first, cursor pagination by uuid v7: `before` is the id of the oldest message held, `nextCursor` is the next `before` (null at the end). `limit` 1 to 200 (default 50). Without `threadRootId`: the channel's own messages (a deleted one stays only while it holds a thread). With it: the live replies. Items are `ChannelMessage`: the message plus `reactions` (`mine` is per caller), `replyCount`, `lastReplyAt`. |
| `POST /api/channels/:channelId/messages` | `PostMessageRequest` (`channelId` must match the path; `threadRootId` is `null` or the first message of a thread; `attachments` is an optional list of up to 10 file ids the sender uploaded to this channel, stored as `meta.attachments` and served as `ChannelMessage.attachments`: see [files.md](./files.md)). 201 `Message`. `body_plain` is derived on the server by the shared `toPlainText` (`packages/shared/src/markup/plain.ts`, linear time): code keeps its text, links and images their label, headings, quotes, bullets and emphasis lose their marks, line breaks stay, and `@person`, `#channel` and `[[thread:..]]`-style refs (and a bare `[[text]]`) are left as typed. 300 per minute per caller. |
| `GET/PATCH/DELETE /api/channels/:channelId/messages/:messageId` | Read one; edit your own (`editedAt`; 409 once deleted); delete your own or, as a team lead, anyone's (idempotent: `deleted: false` the second time). A deleted message is served as a tombstone: `deletedAt` set, `body` `[deleted]`, `bodyPlain` empty. |
| `POST .../messages/:messageId/reactions` `{ emoji }`, `DELETE .../reactions/:emoji` | Add or take back your reaction (needs the post permission to add). Both answer the message's reaction summary. |
| `POST /api/presence` `{ status? }`, `GET /api/presence` | The heartbeat (`online`, the default, or `away`; clients send one every 30 s) and who has beaten in the last 90 s (a guest sees only themself). Presence is read by polling; nothing is pushed. 120 per minute. |
| `POST /api/channels/:channelId/typing` `{ threadRootId? }`, `GET .../typing` | "I am typing here" (needs the post permission; 409 in an archived channel): the row lives 5 s and the response says until when. The listing answers who is typing now, not the caller. Sending a message deletes the sender's row. 120 per minute. |

Refusals: 400 (validation), 401 (no actor), 403 (cannot see, or may not do that), 404 (message or reply target not in a channel you can see), 409 (archived, deleted, name taken, not on the team).

## Mentions and links (P3-07)

On every post and edit, in the same transaction, `src/mentions.ts` parses the body with the shared `parseMarkup` (the composer's parser: code spans and fences, link destinations, URLs, e-mail addresses and
`\@` escapes are never mentions) and records what it names. At most 50 distinct handles, channels and entities per message count.

- **`@handle` to a person.** The rule is `personHandles`/`matchHandle` in `packages/shared/src/markup/handles.ts`, shared with the composer. A person answers to their email local part (`nadia.k`), their
  display name as a slug (`nadia-khan`) and, if exactly one candidate has it, their first name (`nadia`). The candidates are the people who can read the channel and have signed in (`app.channel_mention_candidates`,
  a definer function because `actors` shows a caller only their own row): `@nadia` means the Nadia of this conversation. An exact handle shared by two people, and a first name shared by two, name
  nobody (no guess); so does an unknown handle, a person who cannot read the channel (nothing is learned about them) and the author. A guest resolves nobody (guests see no member list). `@bot` handles
  arrive with bots (`parseMarkup`'s `botHandles`).
- **`message_mentions` rows**: `kind 'person'` with the person's **actor** id as `mentioned_id`, `kind 'channel'` for `#name` (a channel of the same team the author can see; a DM has none). An edit
  inserts what is new and deletes what the new text dropped.
- **Event `channel.mention.created`** (schema v1; ids only): one per person the first time a body names them, as the author, with the team (null in a DM). An edit that keeps a mention does not announce it
  again. The notifications plugin consumes it.
- **Entity links** (`ctx.links.create`, kind `mentions`, message to entity) for `[[thread:<uuid>]]`, `[[file:<uuid>]]` and `[[task:<uuid>]]`: only in a team channel the author belongs to
  (the link table is team-members-only) and only to an entity the author can see (the type's registered resolver answers for the author; none registered, hidden or missing gives no link, never an
  error). An edit removes links the new text no longer holds. `[[page:path]]` and a `[[task:...]]` that is not a uuid wait for those types to have uuid ids (phase 4 and 6).

## Presence and typing (A.3)

Two UNLOGGED tables, so they cost no WAL and are gone after a crash, which nobody minds. Both **expire by themselves**: readers filter by `seen_at > now() - 90 s` and `expires_at > now()`, so no
reaper is needed; every typing request also deletes the expired rows of its channel (the table stays as small as the people typing). Typing is pushed to `app.channel_audience` except the typist as
`typing.started` `{ channelId, personId, threadRootId, expiresAt }` (schema `TypingStartedPush`); a repeat while more than 2.5 s of the previous signal remain is not pushed again, so a client that
repeats every 3 s sends about one push per 5 s. Clients drop the indicator at `expiresAt` or when the person's message arrives.

## Events

Schema version 1, in `packages/shared/src/events`, written as the acting person in the transaction of the change. A refused request emits nothing. Payloads carry ids, never message text.

| Type | Payload (besides `workspaceId`, `channelId`, `teamId` or null for a DM) |
|---|---|
| `channel.message.posted` | `messageId, authorId, threadRootId` (the B.3 shape) |
| `channel.message.edited` | `messageId, editorId, threadRootId` |
| `channel.message.deleted` | `messageId, deletedBy, threadRootId` |
| `channel.reaction.changed` | `messageId, actorId, emoji, added` (only a real change) |
| `channel.channel.created` | `name, kind, private` |
| `channel.channel.updated` | `changes` (only the changed fields) |
| `channel.channel.archived` | `archived` (true to archive, false to restore) |
| `channel.member.added`, `channel.member.removed` | `personId, self` (the audit trail of who sees a private channel) |
| `channel.mention.created` | `messageId, threadRootId, authorId, kind, mentionedId` (actor id), `personId` (see Mentions) |

The plugin consumes `team.template.applied`.

## Team templates

`app.channels_sync_template(team)` creates the template's group "Channels" and each channel of `teams.template_definition` as a get-or-create on `(team_id, name)` behind a marker row in
`channel_template_syncs`, under an advisory lock: it runs once per team, so applying a template twice, a redelivered event and five concurrent directory requests create the four
Customer support channels (`#support #escalations #enquiries #kb-updates`) exactly once, and a channel a lead renamed or archived is never created again. A private template channel starts
with the team's leads. Two doors call it: the `team.template.applied` subscriber (system actor, from the outbox) and `GET /api/teams/:slug/channels` for a member of the team (so a seeded
team, which never had the event, gets its channels the first time anyone opens its sidebar). Each created channel emits `channel.channel.created`.

## Live pushes (WebSocket)

Pushed with `ctx.realtime.pushToPerson(tx, personId, type, payload)` inside the transaction of the change: `pg_notify` at commit, every replica delivers to its own sockets, a rolled-back change
pushes nothing. The audience is `app.channel_audience(channel)`, so a push reaches exactly the people who can read the channel at that moment (checked per recipient set on the server, never in the client).
Envelope `{ type, id, payload }`; schemas in `packages/shared/src/api/channels/realtime.ts`.

| `type` | `payload` |
|---|---|
| `message.posted`, `message.edited` | `{ channelId, messageId, threadRootId, message? }`: the full `ChannelMessage` rides along when it fits in about 5.5 KB (a push may be at most 7 KB), otherwise fetch `messageId` |
| `message.deleted` | `{ channelId, messageId, threadRootId }` |
| `reaction.changed` | `{ channelId, messageId, actorId, emoji, added, count }` |
| `channel.created` | `{ channel }` (also sent by direct-messages when a DM is made) |
| `typing.started` | `{ channelId, personId, threadRootId, expiresAt }`, to the audience except the typist |

## Unread and links (the kernel services)

Posting calls `ctx.readState.onPosted` in the same transaction: a channel message counts for every reader but the author, a thread reply for the followers of the thread (and not as channel unread).
The plugin registers the counters `channel` (top-level messages newer than a position, not the person's own, not deleted) and `thread` (live replies), and the link resolvers `message`
(title: first 80 characters of its plain text, subtitle `#channel`, href `/t/<team>/c/<name>?message=<id>`) and `thread` (`#channel · N replies`, `?panel=thread:<root>`); both run as the
caller, so a private message resolves for nobody else.

## Manifest

| Field | Value |
|---|---|
| name / version / kind | `channels` / `0.1.0` / `server` |
| extends | `event.emit`, `event.subscribe` |
| events | emits the ten types above, consumes `team.template.applied` |
| migrations | `migrations` |

## Tests

`test/channels-api.test.ts` (directory, creation, membership, authz, threads, reactions, 5,000-message pagination, unread, links), `test/realtime.test.ts` (sockets: delivery to permitted people only),
`test/mentions.test.ts` (parsing, resolution, edits, links), `test/ephemeral.test.ts` (presence, typing, expiry), `test/plain.test.ts`, `test/rls/channels-plugin.test.ts` (`pnpm test:rls`: per persona visibility, policies, guards, definer functions, the audience equals the visible sets),
`test/events/channels-events.test.ts` (`pnpm test:events`), `e2e/api/messages/{rls,pagination}.spec.ts` (`pnpm e2e --project=api`; the specs use two test-only routes of `test-kernel`:
`/api/test/bulk-messages` and `/api/test/channel-grants`, both run as the caller).
