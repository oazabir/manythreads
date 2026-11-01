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

## Bot conversations (migration `0006_bot_conversations.sql`, PLAN P5-16)

A channel of `kind = 'bot_conversation'` (reserved since 0001: private, `bot_id`) is a person's conversation with a bot; the
[conversations plugin](./conversations.md) makes it, one per (bot, person), with the bot's team on `team_id` and the person as its only
member, so everything that follows a channel's visibility keeps it theirs. 0006 changes two things of the channels plugin's own:

- **`app.visible_channel_ids`**: a bot actor sees, for `read` and `post`, the bot conversation channel that **its own live run** answers
  in (`bot_runs.channel_id`, the run `running`, the channel's `bot_id` the run's bot) and no other: not the same bot's channels with other
  people, not anything outside a run, not after the run ended. This is what lets the runtime post its reply with `messages.post` as the
  bot. A conversation channel is not readable by a bot as a standing right.
- **`app.channels_remove_member`**: nobody leaves a bot conversation (a DM is the same).

The channel directory (`GET /api/teams/:slug/channels`) lists `kind = 'channel'` only, so a conversation is never in the sidebar.

## Tables (migrations `0001_channels.sql` onward; the table below lists the main ones)

| Table | Notes |
|---|---|
| `channel_groups` | `(team_id, name)` unique; sidebar order by `position`. T. |
| `channels` | `kind` `channel`/`dm`/`bot_conversation`; `private`; unique `(team_id, name) WHERE kind='channel'` and `(workspace_id, dm_key) WHERE kind='dm'`. Names are stored without the `#`. Team, kind, privacy and owner never change (trigger); DMs and bot conversations are not writable through the policy. |
| `channel_members` | PK `(channel_id, person_id)`, `muted`. Read-only for the app role. |
| `messages` | `(channel_id, id DESC) INCLUDE (author_id, thread_root_id)`, partial `(thread_root_id, id)`, GIN trigram `body_plain`, `(author_id)`. Body 1 to 40,000 characters. Edit changes only `body`/`body_plain`/`edited_at` (author, not once deleted); delete sets `deleted_at` once and empties `body_plain` (author or team lead); nothing else changes (trigger). |
| `message_versions` | The earlier texts of an edited message (migration `0009`): `(message_id, channel_id, body, written_at, replaced_at)`. C: readable with the message; written only by the `messages_keep_version` trigger, so the edit route and `messages.update` both fill it. The newest 50 versions of one message are kept. Deleting the message drops them. |
| `message_reactions`, `message_mentions` | `channel_id` is copied from the message by a trigger so the policy can probe the visibility set and a caller cannot claim another channel. |
| `threads` | one row per root message, created and counted **in the same statement** as the reply by a trigger (`reply_count` of live replies, `last_reply_at`, `title` = first 120 characters of the root). The first reply makes the replier and the root's author follow the thread; later replies make only their own replier follow (so a root author who unfollowed stays out). |
| `thread_follows` | P: own rows only, for a message the person can read. The membership of a thread; `read_state.followed` is its mirror, kept by a trigger (see [threads.md](./threads.md#following-one-source-of-truth)). |
| `presence` | `(person_id PK, workspace_id, status 'online'/'away', seen_at)`. **UNLOGGED**. WR: members read everyone of the workspace, a guest only themself; a person writes only their own row. |
| `typing` | `(channel_id, person_id) PK, expires_at`. **UNLOGGED**. C: readable with the channel; a person writes only their own row, in a channel they can post in; anyone who reads the channel may delete rows that have expired. |
| `channel_template_syncs` | S: teams whose template channels were created (see below). |
| `channel_stars` | A person's starred channels (migration `0011`): `(person_id, channel_id)` primary key. P: a person reads, adds and removes only their own rows, and stars only a channel they can read. The row goes with the channel or the person. |
| `sidebar_prefs` | A person's sidebar view of one team (migration `0011`): `(person_id, team_id)` primary key, `sort` (`team`, `recent` or `name`), `hide_idle`, `group_order` (group ids). P: own row only, for a team the person can read. |
| `scheduled_messages` | A person's messages waiting to be sent (migration `0013`, P14-05). P: a person reads, adds, changes and deletes only their own rows, and adds one only to a channel they can post in. See [Scheduled send](#scheduled-send-p14-05). |

Every table has `ENABLE` and `FORCE ROW LEVEL SECURITY`, an `rls:` comment, and passes `findRlsViolations` and `findPerRowPolicyCalls` (`pnpm test:rls`).

## Routes

| Method and path | What it does |
|---|---|
| `GET /api/teams/:slug/channels` | The sidebar directory, shape `NavChannelDirectory`: groups by position with the channels the caller can see (archived ones left out), `unread` from the read state. A team the caller cannot see, or an unknown slug, is `{ groups: [] }` (200, so the shell's 404 feature detection stays on). A **guest** gets only their granted channels in one group "Channels", whatever the slug. Also creates a seeded team's template channels once (below). Each channel also carries `lastActivityAt`: when it last had a message (when it was made, if it has none). |
| `POST /api/teams/:slug/channels` `{ name, purpose?, private?, groupId? }` | Team lead or workspace admin. A leading `#` is accepted. Without `groupId` the channel joins the team's group "Channels" when there is one. A private channel starts with its creator as its only member. 409 for a taken name. |
| `POST /api/teams/:slug/channel-groups` `{ name }` | Lead or admin; the same name again returns the group (`created: false`). |
| `GET /api/channels/:channelId` | The channel plus `isMember`, `canPost`, `canManage` (the composer hides when `canPost` is false). |
| `PATCH /api/channels/:channelId` `{ name?, purpose?, groupId? }`, `POST .../archive`, `POST .../unarchive` | Lead or admin who can see the channel. An archived channel is read-only (409 on changes and posts). |
| `POST .../join`, `POST .../leave` | A workspace member joins a public channel or leaves one (a DM cannot be left). |
| `GET .../members`, `POST .../members` `{ personId }`, `DELETE .../members/:personId` | List (not for guests), add (lead or admin; the person must be on the team), remove (lead or admin, or yourself). |
| `GET /api/channels/:channelId/messages?before=&limit=&threadRootId=` | Newest first, cursor pagination by uuid v7: `before` is the id of the oldest message held, `nextCursor` is the next `before` (null at the end). `limit` 1 to 200 (default 50). Without `threadRootId`: the channel's own messages (a deleted one stays only while it holds a thread). With it: the live replies. Items are `ChannelMessage`: the message plus `reactions` (`mine` is per caller), `replyCount`, `lastReplyAt`. |
| `POST /api/channels/:channelId/messages` | `PostMessageRequest` (`channelId` must match the path; `threadRootId` is `null` or the first message of a thread; `attachments` is an optional list of up to 10 file ids the sender uploaded to this channel, stored as `meta.attachments` and served as `ChannelMessage.attachments`: see [files.md](./files.md)). 201 `Message`. `body_plain` is derived on the server by the shared `toPlainText` (`packages/shared/src/markup/plain.ts`, linear time): code keeps its text, links and images their label, headings, quotes, bullets and emphasis lose their marks, line breaks stay, and `@person`, `#channel` and `[[thread:..]]`-style refs (and a bare `[[text]]`) are left as typed. 300 per minute per caller. |
| `GET/PATCH/DELETE /api/channels/:channelId/messages/:messageId` | Read one; edit your own (`editedAt`; 409 once deleted); delete your own or, as a team lead, anyone's (idempotent: `deleted: false` the second time). A deleted message is served as a tombstone: `deletedAt` set, `body` `[deleted]`, `bodyPlain` empty. |
| `GET .../messages/:messageId/versions`, `DELETE .../versions` | The earlier texts of an edited message, oldest first, each with when it was written and when an edit replaced it (the current text is not in the list). Anyone who can read the message reads them (403 for a channel you cannot see, 404 for a missing message, an empty list for a deleted one). `DELETE` is for the author only (403 otherwise) and answers how many were removed: a secret pasted by mistake and then edited out can be taken out of the history too. |
| `POST .../messages/:messageId/forward` `{ targetChannelId, note? }` | Forward a message you can read into a channel or direct message you can post in. 201 `ChannelMessage`: a new message **by you** (text = your note, or "Forwarded a message") holding a reference to the original in `meta.forward`. 403 when you cannot read the original or cannot post in the target, 404 missing message, 409 for a deleted original, an archived target or a conversation with a bot. |
| `POST .../messages/:messageId/unread` | "Mark unread from here": moves **your own** read position back to just before this message (the message before it in the same feed, or "nothing read" for the first), so it and everything after it count as unread again. For a reply the thread's position moves, otherwise the channel's. Answers the new read state (`ReadStateEntry`). 403 for a channel you cannot read, 404 missing message, 409 deleted message. Nothing is sent to anybody else. |
| `GET/POST .../bookmarks`, `DELETE .../bookmarks/:bookmarkId` | The channel's bookmarks bar, below. |
| `GET/PUT /api/teams/:slug/sidebar-prefs` | The caller's own sidebar view of a team: starred channels, sort, "hide idle channels", order of the groups. See [Your own sidebar](#your-own-sidebar-p14-15). |
| `GET/POST /api/channels/:channelId/scheduled-messages`, `PATCH/DELETE .../scheduled-messages/:scheduledId`, `GET /api/scheduled-messages` | The caller's own scheduled messages: list in a channel, schedule (text only), edit text or time, cancel, and the list of every channel (the "Not sent" list). See [Scheduled send](#scheduled-send-p14-05). |
| `POST .../messages/:messageId/reactions` `{ emoji }`, `DELETE .../reactions/:emoji` | Add or take back your reaction (needs the post permission to add). Both answer the message's reaction summary. |
| `POST /api/presence` `{ status? }`, `GET /api/presence` | The heartbeat (`online`, the default, or `away`; clients send one every 30 s) and who has beaten in the last 90 s (a guest sees only themself). Presence is read by polling; nothing is pushed. 120 per minute. |
| `POST /api/channels/:channelId/typing` `{ threadRootId? }`, `GET .../typing` | "I am typing here" (needs the post permission; 409 in an archived channel): the row lives 5 s and the response says until when. The listing answers who is typing now, not the caller. Sending a message deletes the sender's row. 120 per minute. |

Refusals: 400 (validation), 401 (no actor), 403 (cannot see, or may not do that), 404 (message or reply target not in a channel you can see), 409 (archived, deleted, name taken, not on the team).

## Edit history (P14-12)

`messages_keep_version` (a trigger, so every way of editing is covered) copies the old text into `message_versions` when a message's body changes, with `written_at` (the creation time, or the time of the edit before) and `replaced_at`. The same trigger deletes every version when the message is deleted
(the message row stays as a tombstone, its history does not). The read policy is the message's own (`channel_id = ANY (app.visible_channel_ids('read'))`); no caller can insert or delete a row, and `app.message_versions_clear(message)` lets the author clear their own.
Retention (the retention plugin) never touches messages, so it has no rule for versions; search and memory index `body_plain`, never a version. The web client turns "(edited)" into a button that opens the list.

## Forward cards (P14-12)

A forwarded message stores **where the original is, never what it says**: `meta.forward = { channelId, messageId, threadRootId }`. When a message is served (list, one message, forward response), `forwardsFor` reads the original **as the reader** (row level security of the reader) and
fills `ChannelMessage.forward`: `visible` (author, time, an excerpt of up to 280 characters, the channel's name, so the client can draw "Open the original"), `hidden` (the reader cannot read the original: the client says "You can't see the original message"; no id of it reaches the reader because `meta.forward` is not part of the shared `meta` shape) or `deleted`.
Because the card depends on the reader, a forwarding message is pushed live **without** its body: each client fetches the message itself. The forwarder is the author, so the usual rules apply to their note (post permission, archive, mentions, unread counts). A conversation with a bot cannot be a target. In the threads plugin's own thread view a forwarded root shows its text but no card.

## Copy link (P14-12)

"Copy link" copies `<site>/open?channel=<id>&message=<id>[&root=<id>]` (ids only; `root` for a reply). The `/open` page asks for the message first (`GET .../messages/:id`), so a message you cannot read shows "You cannot see this message." and nothing of it, a deleted or unknown one "This message is no longer there.", and a readable one opens the channel scrolled to it, or the thread panel for a reply.

## Mark unread from here (P14-12)

`POST .../messages/:messageId/unread` calls `ctx.readState.markUnread` (the kernel's read-state service; `markRead` never moves backwards, this is the one door that does). The row is locked while the unread count is taken again with the counter this plugin registered, so a post racing with it is counted once. The kernel emits `reading.state.changed` with reason `read` and pushes the new state to the person's own sockets. The web client holds the view unread while it stays open (opening and watching the bottom do not read it again) and lets go when the person leaves the channel or thread.

## Also send to channel (P14-12)

`POST .../messages` takes `alsoToChannel: true` together with `threadRootId` (400 without one). The reply is posted in the thread as always; the same text and attachments are then posted once more as a **top-level message of the channel** by the same author, carrying `meta.alsoSentFrom = { threadRootId, replyId }`, served as `ChannelMessage.alsoSentFromThread` (the web client shows "Also sent from a thread · View thread"). The two are separate messages: editing or deleting one does not change the other, the copy is not counted as a reply of the thread, it counts as unread for the channel's readers (the reply counts for the thread's followers), and it records no mentions or links (the reply already notified everybody named, so nobody is notified twice). Search finds both.

## Bookmarks bar (P14-12)

`app.channel_bookmarks` (migration `0010`) holds up to 20 entries per channel under the channel header: a `link` (an http or https address with no user name or password), a `file` (the id of a file uploaded to this channel) or a `page` (a Markdown path under `pages/`; team channels only, a direct message has no team). A bookmark stores a reference and a title (80 characters; left out, a link is named by its host, a file by its name, a page by its file name), never content: opening a file or a page is checked again when it is opened. Whoever can read the channel lists them (`GET`); whoever can post adds (`POST`, 201; 400 for an address or path that is not allowed, 409 for a duplicate, the 21st, or an archived channel) and removes (`DELETE`, answers `removed`). The table's policies say the same (read set for `SELECT`, post set for `INSERT` and `DELETE`). The bar draws links and files in a new tab and a page in the team's Files screen. It is read when the channel opens and after your own change; another person's change shows the next time the channel opens (nothing is pushed). The pinned items of a channel (P9-09) will sit beside it in the same row.

## Composer and keyboard (P14-02, P14-10; web client only, no route or table)

**Formatting toolbar.** When the box is focused the composer shows a toolbar (`role="toolbar"`, one tab stop, arrow keys, Home and End move inside it) for the Markdown the renderer already shows: bold, italic, strikethrough, code, a code block (a list picks the language), quote, bulleted and numbered lists, link, mention, channel and emoji. A button wraps the selected text, and pressing it again on text already wrapped takes the marks off; with nothing selected it puts the marks around the caret. Lists and quotes act on every selected line. Ctrl/Cmd+B and Ctrl/Cmd+I work as usual, Ctrl/Cmd+Shift+X is strikethrough. The edits are pure functions in `clients/web/src/channels/composerFormat.ts`. On a phone the toolbar scrolls sideways in one row.

**Emoji picker.** Opens from the toolbar and from "More emoji" in a message's reaction menu. It has a search box, the groups, a "Recently used" row (the last 16, kept in this browser) and a skin tone choice that applies to the hands and people; arrow keys walk the grid and Esc closes it. The set is built in (`clients/web/src/channels/emoji.ts`).

**Up arrow.** In an empty box (also in a thread), the up arrow opens your latest editable message for editing.

**Keyboard.** Ctrl/Cmd+K opens the quick switcher: channels, direct messages, people, bots, files, pages, boards and board cards the person may read (the lists are the ones the screens already load; files use the search route, so the reader's rights apply). Alt+Down and Alt+Up go to the next or previous conversation with unread messages. Esc, with no text box focused and nothing else open, marks the open conversation read; Shift+Esc marks everything read (the unread summary plus the unread thread inbox, using the existing read-state routes). An open channel with unread messages offers "Jump to first unread". `?` opens the list of shortcuts. The code is `clients/web/src/app/QuickSwitcher.tsx`, `quick-switcher.ts` and `readAll.ts`.

**Not built yet.** Custom emoji an admin uploads, `@here` and `@channel` with a confirmation above 20 people, and drafts saved on the server (drafts still stay in this browser) each need a table or server rule of their own.

## Slash commands (P14-06; web client only, no new route or table)

Typing `/` as the very first character of the message box opens a small menu of commands (an accessible list: arrow keys move, Enter or Tab picks, Esc closes and keeps the text; on a phone it opens above the box with rows at least 44 px tall). The list and the reading rules are one registry in `packages/shared/src/commands` (`SLASH_COMMANDS`, `parseSlash`, `slashMenuContext`), used by the channel composer, the thread composer and the tests; what each command does, and whether this person may use it, is `clients/web/src/channels/slash.ts`. A command the person cannot use is shown disabled in the menu with a plain reason, and typing it in full gives the same sentence instead of sending anything. The server is still the only authority: every command ends in an existing route or an ordinary message, so a refusal comes back from that route and is shown as one sentence.

| command | what it does | needs |
|---|---|---|
| `/ask <bot> <question>` | posts `@<bot> <question>` as an ordinary message, so the bot's `mention` trigger wakes it. After `/ask ` the menu lists the team's bots that are switched on; a name that is not one is refused with the list of bots, and nothing is posted | a member of the team (a guest is shown it disabled) |
| `/task <title>` | creates a card with `POST /api/teams/:slug/tasks` (kind `other`, branch taken from the title, description "Created from #dev with /task."). In a channel that has a Bot Board the card goes on it; otherwise on the team's default board. The box shows "Card created" with an "Open the card" link; a message is not posted | a member of a team that is not archived |
| `/me <text>` | posts `*Name text*`, an italic line about yourself | anyone who can post |
| `/shrug [message]` | posts the message followed by the shrug face (stored escaped so it renders whole) | anyone who can post |
| `/help` | opens a dialog listing these commands and, for any this person cannot use, why | anyone |

**What is never swallowed.** The text is a command only when it starts with `/` at character 0 and the word right after names a command above. Anything else is posted as typed: an unknown `/xyz`, a path such as `/etc/hosts`, a message that has a command word later on, and a message that starts with a space. To post a command word as plain text, start with two slashes and a letter: `//ask coder hi` posts `/ask coder hi`. Two slashes followed by anything else (a `// comment`) are left exactly as typed. A command with a missing part (no bot, no question, no title, a title over 200 characters, files attached to `/task`) is not sent and not cleared: a sentence says what to add. The menu opens only while the first word, or for `/ask` the bot after it, is being typed, so it never opens in the middle of a message, on a second line or inside a code block. A conversation with a bot has no commands at all (its text, `//` included, is posted as typed).

**Not built, on purpose.** `/remind` belongs to P14-04; `/status`, `/dnd`, `/away`, `/poll`, `/invite`, `/leave`, `/mute` and `/topic` need server rules or a command registry that do not exist yet (polls P14-07; Do not disturb now has a screen, see [presence.md](./presence.md), but no `/dnd` or `/status` command). A bot cannot declare commands: `BOT.md` has no `commands` field and no `command` trigger exists, so the menu lists only the built-ins above and nothing is invented for bots. `/ask` wakes only a bot whose definition has a `mention` trigger; the page cannot tell which bots have one, so it lists every bot that is switched on.

## New channel and sidebar unread (P14-15; web client only)

**New channel.** Under the channel groups the sidebar shows "+ New channel" to the people the server lets create one: a lead of the team or a workspace admin, in a team that is not archived (`canCreateChannel` in `clients/web/src/shell/newChannel.ts` mirrors the rule of `POST /api/teams/:slug/channels`, which stays the only authority). A plain member and a guest do not see the button; the server still answers 403 if they call the route. The dialog (shared `.dlg` styles, `clients/web/src/shell/NewChannel.tsx`) asks for a name, an optional topic (sent as `purpose`, at most 250 characters) and who can see the channel: everyone on the team (public) or only the people added afterwards (private; the creator is its first member). A typed name is cleaned the way the server stores it (no `#`, lowercase, spaces and underscores become one dash) and a name the server would refuse is explained before anything is sent. A refusal gets one plain sentence: 409 name taken (or team archived), 400 invalid name or topic, 403 not allowed, 404 no such team, 429 too many tries. After creating, the web app opens the new channel; other people on the team get a public channel in their sidebar through the existing `channel.channel.created` push. Putting the new channel in a group other than the team's default "Channels" group is not offered yet (the route takes `groupId`).

**Sidebar unread.** Every channel and direct message row shows its unread count from the read state (`GET /api/teams/:slug/channels` seeds `unread`, `reading.state.changed` pushes keep it live) as a count badge, and a bold label. How loudly it shows follows the person's notification level for that conversation (P14-09, `clients/web/src/shell/unreadLook.ts`): at "all messages" or "mentions" the label is bold and the badge is highlighted; at "nothing" the count stays but is grey and the label is not bold. Opening the conversation reads it, so the badge and the bold label go away at once. A count above 99 shows as "99+".

## Your own sidebar (P14-15)

Everything here sits inside slot 40 of the sidebar contract (the channel groups); the seven slots and their order do not change. It is a person's own view: nobody else sees it, it is kept on the server so it follows the person to another device, and no event is emitted (like a notification level, it tells nobody anything).

**What is kept.** `GET /api/teams/:slug/sidebar-prefs` answers `{ starred, sort, hideIdle, groupOrder }` (`SidebarPrefs`, `packages/shared/src/api/channels/sidebar.ts`); a person who never changed anything gets no stars, `team` (the order the team set), `false` and no order. `PUT` changes any of them and leaves the rest (400 when the body is empty or names an unknown field); it answers the saved view. Stars are sent as changes, not as a whole list: `starAdd` and `starRemove` (a tab that is out of date can therefore not undo a star made on another device). 120 writes a minute. Writes for one person and team are taken one at a time (an advisory lock), so two devices cannot interleave their list replacements.

| Field | Meaning | Server checks |
|---|---|---|
| `starAdd` | channel ids to star | each must be a channel (not a direct message) of this team that the caller can read and that is not archived (403 for a channel they cannot see, the same answer as for one that does not exist; 400 for one of another team or an archived one); the stars left after the change, counting the ones being added, are at most 100 (400 otherwise); a channel already starred is left as it is |
| `starRemove` | channel ids to unstar | the caller's own stars in this team; a channel that is not starred is left alone; the same id in both lists is a 400 |
| `sort` | `team` (the order the team set: group, then position; the default), `recent` (newest message first) or `name` | closed set |
| `hideIdle` | fold away channels with no message for 30 days | boolean |
| `groupOrder` | group ids in the person's order; replaces the whole order | each id must be a group of this team, or the team's own id (the id the directory gives channels that sit in no group), once each (400 otherwise) |

A star on a channel the person can no longer read, or that was archived, is not listed (the row stays in the table, and does not count toward the 100); a group that no longer exists drops out of `groupOrder` when it is read. Channel groups themselves are still the team's (a lead makes them); only their order is personal. A guest has no team to arrange: both calls answer 403 for them and the web client shows the default layout without the controls.

**The directory** (`GET /api/teams/:slug/channels`) carries `lastActivityAt` for every channel (the time of its newest message, or of its creation when it has none), one index probe per channel; a deleted message does not count. Sorting and hiding are done in the browser (`clients/web/src/shell/sidebarLayout.ts`, pure functions with tests), so the server order of the directory is unchanged.

**What the person sees** (`clients/web/src/shell/ChannelGroups.tsx`).
- **Starred**: a group at the top of slot 40, shown only when there is at least one star. A starred channel is listed there and in no other group; a group whose channels are all starred disappears. A channel is starred from its row menu (a button shown on hover and keyboard focus, always visible on a touch screen, also opened by right click; "Star channel" or "Remove star") or from the star in the channel header (hidden on a phone, where the title needs the room).
- **Sort**: the small "Channel list options" button at the right of the first heading (it stays in place when groups move, so an open menu does not close) opens a menu: Team order (default, the sidebar as it always was), Recent activity, or Name. It orders the channels inside every group and the Starred group the same way; with Team order the Starred group follows the groups as shown, then the team's order inside each. Recent activity follows live: a message pushed to the page, or sent from it, moves its channel up without another fetch.
- **Hide channels idle for 30 days**: a checkbox in the same menu. An idle channel collapses into a row at the end of its group that reads "3 quiet channels hidden", which expands. A channel with unread messages (a mention is unread too), the channel that is open, and a starred channel are never hidden; a channel whose last activity is unknown is not hidden either.
- **Order of the groups**: drag a group by the grip that appears at the left of its heading (mouse or pen), or use the "Move <group> up" and "Move <group> down" buttons in the options menu, or press Alt with the up or down arrow on a focused heading (the menu says so, and the heading carries `aria-keyshortcuts`). Only the groups on screen move; a group that is not shown (every channel starred, or none to see) keeps its place among the others. The Starred group always stays first.
- A change shows at once and is sent in the order it was made; if the server refuses it, the old value comes back and one plain sentence appears under the list. With a newer change already waiting, a refused one is not shown flipping back; the answer to the newest change settles it. The list draws at once with the defaults and never waits on the request; the controls appear when the person's own view has arrived. A first request that failed is asked again on the next load. The view is asked for again when the tab comes back to the front (at most every 15 seconds) and when the socket reconnects, so stars made elsewhere appear. When another person signs in, anything still on its way for the previous one is dropped. Code: `sidebarPrefsStore.ts` (store), `ChannelStar.tsx` (header).
- Keyboard and screen readers: after a star, a move or Alt+Arrow, focus goes to the row or heading in its new place (a Move button that became disabled hands focus to the other one), a hidden `role="status"` line says what happened ("Starred #dev", "Moved group Projects up", "3 quiet channels hidden"), Tab closes an open menu and carries on from its button, and right click on a row is left to the browser (the "…" button opens the row menu).

Tests: `packages/plugins/channels/test/sidebar-prefs.test.ts` (routes), the `stars and sidebar preferences` block in `test/rls/channels-plugin.test.ts` (row level security), `clients/web/test/sidebar-layout.test.ts` and `sidebar-prefs-store.test.ts`.

## Scheduled send (P14-05)

A person can write a message now and have it posted later, as themself. The send button has a small button beside it ("Send later") with the times "Remind me" offers (20 minutes, 1 hour, tomorrow morning, next week) and "Pick a date and time...". Above the box, a strip says "2 scheduled" with each message, its time, **Edit** and **Cancel**; it is drawn only while there is something to show. It works in the channel box and in a thread's reply box (the strip of a thread shows that thread's messages).

- **Table.** `scheduled_messages` (migration `0013`): `author_id`, `channel_id`, `team_id` (copied from the channel when it is scheduled, so an event can name the team even when the author can no longer read the channel), `thread_root_id` (no foreign key: a deleted root is found out at send time), `body` (1 to 40,000 characters, text only: no files, no slash commands), `send_at`, `state` (`scheduled` or `refused`), `refused_reason`, `refused_at`, `attempts`, `retry_at` (set while the post door asked to try again later). Policy (person-owned): every row is read, changed and deleted only by `author_id = app.actor()`; an insert needs the author to be the caller (a person, not a bot), the channel to be one they can post in (`app.visible_channel_ids('post')`) and `state = 'scheduled'`. A person can never mark a row `refused`: only the system job does. A guard trigger lets a person change only the text, the time and the retry fields (never the channel, the author or the team). A trigger refuses a 101st waiting message for one person (a lock makes the count safe under parallel requests).
- **Routes** (person only: a bot gets 403; 60 new schedules and 120 of every other call a minute). Scheduling needs the post permission and a time between now (a minute of clock difference is allowed) and one year ahead; 400 otherwise, with a sentence saying which. Editing a `refused` message with a new time puts it back to `scheduled` and starts its counters over. Listing (in a channel, or `GET /api/scheduled-messages` for every channel, newest 200) and cancelling need **no right to read or post in the channel**: a draft whose author lost access must stay findable and removable (and must not hold one of the 100 places for ever). Cancelling answers `{ cancelled }` and is safe to repeat. Editing needs the post permission, so a person who lost access can copy the text and dismiss the draft but not reschedule it.
- **The job.** `channels.send_scheduled` runs every minute, one run at a time (`concurrency: 1`), as a *detached* job: it holds no transaction open, but lists the due rows a page of 100 at a time (each page after the last row of the one before) and goes on page after page until nothing is due or 45 seconds are spent (the next minute takes the rest). A message goes out within about a minute after its time. For each due row it opens a transaction **as the author**, locks the row (`FOR UPDATE SKIP LOCKED`, so two replicas never take the same one, and a row that an edit or a cancel is changing is left to that edit or cancel), posts through the same function the composer uses (`postChannelMessage`), deletes the row and records the event, all in one transaction. A failure rolls everything back, so a message is posted once or not at all. A row whose handling throws is counted and passed over: it never holds up the rows after it.
- **The check at send time.** Because the post is made as the author, the normal rules run again: the author must still see the channel and be allowed to post (a person who left a private channel, was suspended, or lost the post permission is refused), the channel must not be archived, and a thread root must still exist and not be deleted. A refusal (a 4xx) turns the row into `refused` with the door's reason in plain words (never empty); the message is **not lost**: it stays in the channel's strip as "Not sent. <reason>" and in the "Not sent" list at the top of Later, to edit and schedule again or to dismiss, and the author's open tabs are told. The update that marks a refusal is tied to the row as the send read it (`updated_at`), so an edit made while the send was failing is never overwritten. A failure that may pass (database busy) is retried on the next minute, counted, and on the third refused with a general sentence. A **429** from the door ("busy, try later") is not a refusal and is not counted: the row waits until the time the door named (`retry-after`, one minute when absent, at most an hour), and is refused with a sentence only after a whole day of waiting.
- **Event.** `channel.scheduled_message.changed` with `change` `scheduled`, `edited`, `sent`, `refused` or `cancelled`. It carries ids only (no text, no time, no reason), and the team is read from the row. A sent or cancelled row is deleted; this event log is the record of it. (A notification for a refused message is not built yet; the `refused` event is there for it, and the strip and the "Not sent" list show the reason meanwhile.)
- **Client.** The send button has a small button beside it (hidden while "Also send to channel" is ticked in a thread, which a scheduled reply would drop; and while a request is out, so Send and Send later cannot both fire). The strip above the box lists the channel's scheduled messages, including replies scheduled into its threads ("In a thread"); a thread's own box lists that thread's. The "Not sent" list at the top of the Later tab shows every refused message of the person, from any channel, with Copy text, Edit and reschedule, and Dismiss. An edit sends the time only when the time field was changed.
- **Limits.** Text only; 100 waiting messages per person; at most one year ahead; about one minute of precision.

## Author names (`ChannelMessage.author`)

`people` and `actors` show a caller only their own row and a guest has no roster, so a client could not name the author of a message (it showed "Someone"). Every `ChannelMessage` the
channels and threads plugins serve (channel lists, one message, a thread root and its replies, the `message.posted` push) therefore carries `author: { actorId, displayName, kind }`, resolved
by `app.message_authors(message_ids uuid[])` (migration `0005`, a definer function). It joins the ids to `app.visible_channel_ids('read')` **of the caller** first and looks an actor up only
for a message that survives, so an id of a message in a channel the caller cannot read, an actor id or a made-up id answers nothing (at most 500 ids per call). A person is named by
their display name; a bot and the system by a fixed label until the bots plugin gives bots names. The field is optional in the schema (older fixtures still parse); `test/authors.test.ts`
covers guests, a private channel, another team and the no-leak cases.

## Mentions and links (P3-07)

On every post and edit, in the same transaction, `src/mentions.ts` parses the body with the shared `parseMarkup` (the composer's parser: code spans and fences, link destinations, URLs, e-mail addresses and
`\@` escapes are never mentions) and records what it names. At most 50 distinct handles, channels and entities per message count.

- **`@handle` to a person.** The rule is `personHandles`/`matchHandle` in `packages/shared/src/markup/handles.ts`, shared with the composer. A person answers to their email local part (`nadia.k`), their
  display name as a slug (`nadia-khan`) and, if exactly one candidate has it, their first name (`nadia`). The candidates are the people who can read the channel and have signed in (`app.channel_mention_candidates`,
  a definer function because `actors` shows a caller only their own row): `@nadia` means the Nadia of this conversation. An exact handle shared by two people, and a first name shared by two, name
  nobody (no guess); so does an unknown handle, a person who cannot read the channel (nothing is learned about them) and the author. A guest resolves nobody (guests see no member list). `@bot` handles
  arrive with bots (`parseMarkup`'s `botHandles`).
- **`@role` to a group of people (P14-03).** A role tag the team defines in `TEAM.md` (`role:on-call`) is also a handle (`@on-call`) for the team members who hold it. The tags and holders
  come from the teams plugin through the `role.groups` provider (`ctx.providers.get<RoleGroupProvider>('role.groups')`, `packages/sdk/src/role-groups.ts`); this plugin keeps no table of groups. The rules, in the order a word is read:
  1. **An exact person handle wins.** If anyone on the team answers to the word with the local part of their email or their name as a slug, or a bot of the team has it as its slug, the tag is not a mention handle
     (`mentionable: false`, `closedBy` says `person` or `bot`) and `@word` keeps its old meaning. A **first name does not win**: anyone could otherwise kill a team's tag by joining with that first name. For a
     word that is also a tag, `@word` therefore finds a person only by an exact handle; where no tag has the word, a first name still finds its one person as before. Two people with the same exact
     handle are ambiguous: `@word` names nobody and the tag is closed, which a lead sees in the tag list. The check is made on the whole team roster, so a team member who cannot read this particular channel still closes the word there.
  2. **Reserved words are never handles** and a team cannot define a tag with one: `here`, `channel`, `everyone`, `everybody`, `all`, `admin`, `administrator`, `owner`, `team`, `staff`, `security`, `moderator`, `mod` and the
     plurals (`packages/shared/src/markup/role-handles.ts`, `RESERVED_GROUP_HANDLES`, used by the rule and by tag creation alike; the teams API answers a plain 400 sentence). An older tag with such a word stays a group for hand-overs and is closed for `@`.
  3. Otherwise the tag is the group. The rule is `roleGroups`, shared with the composer.
  A rename can close a tag later (a person is renamed to the word): the team's tag list (`GET /api/teams/:slug/tags`, `mentionable` and `closedBy`) shows it; the one audit row (`team.tag.handle_closed`) is written when the tag is defined.
  A group in a message names the holders **who can read this channel** (`app.channel_role_audience`, a definer function that refuses a guest and a caller who cannot read the channel): in a private channel, team members
  who are not in it are not named and nothing says they hold the tag. A direct message has no team and so no groups. Each person is named as for `@person` (a `message_mentions` row and a `channel.mention.created` event with their ids; the
  author never; once even when named directly as well), so levels, Do not disturb and the author rule of the notifications plugin apply with no extra code, and **a role mention never starts a bot run**: bots cannot hold role tags,
  and the bot router matches `@handle` against bot slugs only (a bot slug wins any collision).
  **Limits.** One message notifies at most **500 people per group** (the first 500 by person id, the author excluded); when a group is cut, the post answer carries `groupNotices: [{ handle, reached, notified }]` so the author can tell the
  rest in person (the picker still counts everyone). **Budget:** per author and team, at most 5 group mentions in a minute and 1,000 people reached in an hour (`src/mention-budget.ts`, in memory per replica like the other limits);
  over it the post is refused with a 429 and the plain sentence "You mentioned groups too often; try again in a minute." (or, for the hour, "Your group mentions have reached too many people this hour; try again later."), and nothing is posted.
  A group already named before an edit is not charged again. The events of a big group are written with `ctx.audit.emitMany` (a fixed number of statements, not one round trip per person). When the team has no role tag at all, or every
  `@word` of the message is a bot's slug, the provider does not read the roster.
  **Who counts as the author.** A message written by a person, or by the server in the system role under an actor of its own, reaches groups (and has its own budget per actor). A message written by a bot reaches nobody through groups
  (the same door as `@person`: a bot's mentions are not read). The text of an incoming webhook or alert never reaches a group or a person: the webhooks plugin breaks every `@` of outside text.
  **Edits.** An edit keeps the rows it has. It adds rows and announcements only for what it newly names (a direct `@person`, or a group whose handle the old text did not have), so a member who joined the tag since is not added by a wording change.
  It removes rows only of people it stopped naming: a direct `@person` that was deleted, or the holders of a group whose handle was deleted (while the handle stays, a person who left the tag keeps their row).
- **`GET /api/channels/:channelId/mention-groups`** (P14-03, 120 a minute): the groups the composer's `@` picker offers in this conversation, `{ groups: [{ handle, tag, memberCount }] }` in handle order. `memberCount` is the number of
  holders who can read the channel (the caller included if they hold the tag; never capped), so the picker never shows a membership the channel hides. **It is the count of readers who hold the tag, not exactly the number a mention
  notifies:** a mention leaves out the author and notifies at most 500 per group. Groups nobody there holds, groups that lose a collision and a conversation without a team are left out, and a guest gets `[]`. A caller who cannot
  read the channel gets 403 like every channel route. The web composer asks only after the person types an `@`, keeps the answer for a minute per person and channel (dropped when the person changes or signs out, and never shown for
  another channel) and draws a group below the people with a "Group" badge and "N people".
- **`message_mentions` rows**: `kind 'person'` with the person's **actor** id as `mentioned_id`, `kind 'channel'` for `#name` (a channel of the same team the author can see; a DM has none). An edit
  inserts what is new and deletes what the new text dropped.
- **Event `channel.mention.created`** (schema v1; ids only): one per person the first time a body names them, as the author, with the team (null in a DM). An edit that keeps a mention does not announce it
  again. The notifications plugin consumes it.
- **Entity links** (`ctx.links.create`, kind `mentions`, message to entity) for `[[thread:<uuid>]]`, `[[file:<uuid>]]` and `[[task:<uuid>]]`: only in a team channel the author belongs to
  (the link table is team-members-only) and only to an entity the author can see (the type's registered resolver answers for the author; none registered, hidden or missing gives no link, never an
  error). An edit removes links the new text no longer holds. `[[page:path]]` and a `[[task:...]]` that is not a uuid wait for those types to have uuid ids (phase 4 and 6).

## Link previews (P14-08)

A message that carries a web link gets a card under it (site, title, description, picture) made by the [link-preview](./link-preview.md) plugin from the `channel.message.*` events; this plugin only owns the message. A link dropped into the team inbox is never read.

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
| `channel.scheduled_message.changed` | `scheduledId, authorId, change` (`scheduled`, `edited`, `sent`, `refused` or `cancelled`), `messageId` (set on `sent`). Ids only: no text, no time, no reason (the event log is readable by the team; a scheduled message is private to its author). |

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
| `scheduled.changed` | `{ channelId, change }` (`change` as in the event above), to the author only: another tab, or the job that sent or refused the message, tells this one to read the list again |

## Unread and links (the kernel services)

Posting calls `ctx.readState.onPosted` in the same transaction: a channel message counts for every reader but the author, a thread reply for the followers of the thread (and not as channel unread).
The plugin registers the counters `channel` (top-level messages newer than a position, not the person's own, not deleted) and `thread` (live replies), and the link resolvers `message`
(title: first 80 characters of its plain text, subtitle `#channel`, href `/t/<team>/c/<name>?message=<id>`) and `thread` (`#channel · N replies`, `?panel=thread:<root>`); both run as the
caller, so a private message resolves for nobody else.

## `messages.post` (P5-10)

One capability, so a bot can post: `messages.post` takes `{ channelId, body, threadRootId? }` and answers the new message's ids. Inside a bot run that has a reply place (a mention, conversation, channel message or task assignment), `channelId` may be left out (it is the run's channel), and a post to that same channel with no `threadRootId` goes into the run's reply thread; an explicit `threadRootId` is used as given and another channel is untouched. The message carries `meta.runId` (taken from the transaction's run, never from the arguments), which is how the runtime knows the run already spoke and posts no second, final-text message.
It is not a second write path — the route and the capability both call `postChannelMessage` in `service.ts`, so a bot's reply gets
permission, thread rules, attachments, the event, the live push, the unread counters and mention resolution exactly as a person's
message does. The author is the transaction's actor (the run's bot) and the permission is `app.channel_can(channel, 'post')`: a bot
is a member of its team (the loader writes that row), so it may post in its team's public channels and nowhere else — never a
private channel, never a DM. `messages.search` stays the search plugin's; this plugin owns the write side only.


## `messages.update`

A bot can replace the text of a message it posted itself, for example one checklist it keeps current in a thread instead of posting a new one each time. It takes `{ channelId?, messageId, body }` (the same 1 to 40,000 character limit as a post; `channelId` may be left out inside a run that has a reply place) and answers the message's ids. It goes through `editChannelMessage`, the function the edit route (`PATCH /api/channels/:channelId/messages/:messageId`) also calls, so the author check (only the bot's own message; a person's message or another bot's is refused 403), the `channel.message.edited` event and the live `message.edited` push to clients are the same as for a person's edit. One difference: an edit by a bot never re-reads mentions or links, so a name added in an edit is plain text and nobody is notified or woken; to hand something over, post a new message or hand over a card.

## The `messages` provider (P5-18)

`ctx.providers.get<MessageProvider>('messages')` (extension point `provider.messages`, type in `packages/sdk/src/messages.ts`) is how
**another plugin** posts a message that carries more than text: `post(tx, { channelId, body, threadRootId?, meta? })`. It calls the same
`postChannelMessage` as the route and the capability above, as the transaction's actor. `meta` is the platform's own bookkeeping and is
validated here, so a plugin cannot store something clients will not read: `{ answer: AnswerPayload, runId }` only (the answer plugin;
[answer.md](./answer.md)), anything else is a 400. It is a provider and not a capability on purpose: a capability is what a bot's model can
be granted and call with arguments of its own, and `messages.post` takes no `meta`, so no tool can write an Answer. `meta.answer` and
`meta.runId` then ride on `Message.meta` like `attachments` do (a deleted message shows `{}`), and `runtime-hermes` reads `meta.runId` to know
a run already answered. The provider checks the meta against the transaction instead of trusting it: `meta.runId` is the run the transaction
acts for (`app.run_id()`; 403 otherwise), an `answer` names that run and the posting bot in `answeredFor` (403) and carries the message's own
text as `body` (400). Migration `0007` adds the partial unique index `messages_one_answer_per_run` (one live message with `meta.answer` per
`meta.runId`).

**A person's copy of their own answer (P5-17).** `post(tx, { channelId, body, meta: { answer }, copyOf: <answer message id> })` posts a masked
copy as the person the transaction acts for, with no run. `copyOf` makes the provider check the claim against the stored original, in the caller's
own `bot_conversation` channel: the caller is the person the answer was for (403 otherwise, for another person's answer, a message in a channel, an
id that is nothing, or a bot), `answeredFor` is the original's, the copy's text is the original's with whole sentences taken out (a subsequence)
and is the message's own text, every citation is the original's by number (a masked one, or the same citation but for its label), the lineage and
"Sources reached" are subsets, and there are no chips (400 otherwise). A `meta.runId` with `copyOf` is a 400. Nothing about the original is stored
on the copy. Editing a message that carries an Answer is refused (409): the text must stay the payload's `body`.

## Manifest

| Field | Value |
|---|---|
| name / version / kind | `channels` / `0.1.0` / `server` |
| extends | `event.emit`, `event.subscribe`, `job.register`, `provider.messages` (uses, without extending, the teams plugin's `role.groups` provider) |
| capabilities | `messages.post`, `messages.update` (neither destructive) |
| events | emits the eleven types above, consumes `team.template.applied` |
| migrations | `migrations` |

## Tests

`test/message-actions.test.ts` (edit history, clearing it, forward cards per reader, the push of a forward), `test/channels-api.test.ts` (directory, creation, membership, authz, threads, reactions, 5,000-message pagination, unread, links), `test/realtime.test.ts` (sockets: delivery to permitted people only),
`test/mentions.test.ts` (parsing, resolution, edits, links), `test/role-mentions.test.ts` (role groups: holders, collisions, private channels, edits, the picker route), `test/ephemeral.test.ts` (presence, typing, expiry), `test/plain.test.ts`, `test/rls/channels-plugin.test.ts` (`pnpm test:rls`: per persona visibility, policies, guards, definer functions, the audience equals the visible sets),
`test/events/channels-events.test.ts` (`pnpm test:events`), `e2e/api/messages/{rls,pagination}.spec.ts` (`pnpm e2e --project=api`; the specs use two test-only routes of `test-kernel`:
`/api/test/bulk-messages` and `/api/test/channel-grants`, both run as the caller).
Scheduled send: `test/scheduled-send.test.ts` (routes, bot 403, the job and its clock, refusals at send time: archived channel, left channel, deleted thread root, suspended author, a failure counted to three, a row held by an edit or cancel, a direct message with a null team, the cap, a content-blind event log), `test/scheduled-job.test.ts` (no database: one bad row, a 429, an empty reason, the tie to `updated_at`, paging, the time budget), `packages/shared/test/scheduled.test.ts`, `clients/web/test/scheduled.test.ts` (the client's copy, including a forced re-read) and `e2e/channels/scheduled.spec.ts` (the menu with the keyboard and Escape, the strip, the phone).
Web client: `clients/web/test/new-channel.test.ts` (who is offered New channel, the cleaned name and request, one sentence per refusal, the unread look per notification level) and `e2e/shell/new-channel.spec.ts` (a lead makes a public and a private channel through the dialog, a member is not offered it, a second person sees the row bold with a count and opening clears it, a "nothing" channel keeps a grey count).
