# conversations

Talking to a bot (SPEC §6.2, PLAN P5-16). Code: `packages/plugins/conversations`. Schemas: `packages/shared/src/api/conversations`,
`packages/shared/src/entities/conversation.ts`, `packages/shared/src/events/conversations.conversation.started.ts`. Web: `clients/web/src/screens/conversations`
(`/t/:team/bots/:botSlug/chat`).

A conversation is an **ordinary thread**. The person's first message is its root, the bot replies in it, and following, unread, the thread view,
entity links, search and pages work unchanged. What this plugin adds is the place the thread lives, the door that makes it, an index that records
who may find it, and the lists.

## One private channel per bot and person

SPEC §6.2 says "a per-bot conversations channel the sidebar does not list" and "private to the person by default". Message visibility in this
platform is a property of a **channel** (`app.visible_channel_ids`, hoisted into the policies of messages, threads, reactions, mentions, read
state, search and notifications), so one shared channel per bot could not be private without a rule of its own in every one of those plugins.
The decision: **one channel per (bot, person)** — kind `bot_conversation`, private, the bot's `bot_id`, the bot's team on `team_id`, and the person
as its only member. Everything that follows a channel then keeps one person's conversation from another's with no new rule, and a workspace admin
who is not the asker reads nothing (as with a DM).

`app.conversations_open(bot_id) -> (channel_id, created)` (migration `0001`, `SECURITY DEFINER`, owned by `manythreads_system`; the channels
policy never lets a caller insert such a channel) is the one door, written like `dms_get_or_create`: one statement,
`INSERT … ON CONFLICT (workspace_id, bot_id, created_by) WHERE kind = 'bot_conversation' DO SELECT`, with the channel and its member together
(the partial unique index `channels_bot_conversation` is created by this migration). Refused: a guest, a person who is not on the bot's team (the
run that answers is opened for a person of the team; `ctx.runs.open` refuses anybody else), a bot that is not `active`, a bot actor, an unknown
bot. The channel keeps the bot's team on `team_id`, so a person who leaves the team stops reading their conversations (channels 0004's rule) and
the router finds the bot's team from the channel.

What the **bot** may do in it is channels migration `0006` ([channels.md](./channels.md#bot-conversations-migration-0006_bot_conversationssql-plan-p5-16)):
read and post in the one conversation channel its own live run answers in, and nowhere else.

## Sending starts a thread

There is no route for sending: the web client posts the first message into the channel `open` returned with the ordinary
`POST /api/channels/:id/messages`, and a reply in the thread goes the same way. The runtime-hermes router (`channel.message.posted`) then
decides: a message in a `bot_conversation` channel fires **that channel's bot's `conversation` trigger** and no other (no other bot of the team is
considered; a `mention` or `channel_message` rule never fires there), as the author's own run (`asker` = the person, `trigger_type` =
`conversation`, `channel_id` = the conversation channel, `reply_root_id` = the thread root). The reply is posted as the bot with `messages.post`
through the broker like every runtime call. The prompt of such a run is `<person>:\n\n<message>` (a conversation channel has no name).
A bot whose definition lists no `conversation` trigger has no conversation to open: `open` answers **409 `bot_has_no_conversation_trigger`**
(checked before anything is made, so no channel appears), the roster and the bot page carry `conversational: false` (`BotSummary`, read from the
loader's `bots.triggers`) and the clients show Talk disabled with "Nobody can talk to this bot: its definition has no conversation trigger", and
the Triggers tab says the same. A bot that *drops* the trigger later keeps the channel its people already have: nothing answers in it (the router
answers a conversation channel for that trigger alone), the lists still show the past conversations, and the view replaces the message box with
the reason instead of hiding them.

## The index and its visibility

`app.conversations` (migration `0001`; `thread_root_id` PK referencing the root message; `team_id`, `bot_id`, `person_id`, `channel_id`):

| Column | Meaning |
|---|---|
| `visibility` | `private` (the asker only) or `shared` (the bot's team lists it under Shared). CHECK, shared with the Zod `ConversationVisibility`. |
| `shared_to`, `shared_root_id`, `shared_by`, `shared_at` | where the shared copy was posted, the message it made there, who shared and when (the latest share of the conversation; [Sharing](#sharing-an-answer-p5-17)). Written by `app.conversations_mark_shared` (migration `0002`). Constraints: `shared` ⇔ `shared_at` set; a share target only while shared. |

The row holds **no text**: a title or a preview is read from the messages with the reader's own visibility, so an edit or a deletion can never
leave a stale copy on an index row (MISTAKES P5-13 on denormalised copies). Another person's shared conversation is listed through the copy that
was posted into a channel the reader can read (`shared_root_id` in `shared_to`); with no readable copy it is listed with no title and cannot be
opened. RLS (`conversations_select`, hoisted): the asker's own rows, and `shared` rows of the teams the caller may read; callers cannot write the
table at all (the system role does: the indexer below, and the sharing door `app.conversations_mark_shared`).

The index is written by a `channel.message.posted` subscriber: a **root** message (no `thread_root_id`) in a bot conversation channel, authored by
the channel's person, inserts the row (idempotent on the root id) and announces `conversations.conversation.started` (below). It is not in the
request's transaction, so the list may trail the send by the outbox's latency; the client opens the new thread by id and asks the list again.

## Routes

| Method and path | What it does |
|---|---|
| `POST /api/teams/:slug/bots/:botSlug/conversation` | Opens (get-or-create) the caller's channel with the bot: `{ botId, botName, botRole, channelId, created, prompts, promptSource }`; 201 when this call made it, 200 when it existed. 403 for a person who may not talk to the bot, 404 for an unknown bot, 409 for a bot that is turned off or invalid, and 409 with code `bot_has_no_conversation_trigger` for one whose definition has no `conversation` trigger. |
| `GET /api/teams/:slug/bots/:botSlug/conversations?scope=mine\|shared\|mentions&limit=&cursor=` | One of the three lists, newest activity first (`last_reply_at`, else the root's time; the cursor is `<microseconds>:<thread id>`, at most 16 digits: anything else, including a number past a bigint, is a 400 rather than a failed cast). The lists stay readable for a bot that cannot answer (turned off, invalid, no trigger). The web view's "Show older" follows `nextCursor`. |
| `POST /api/teams/:slug/bots/:botSlug/test` | The bot page's Test action (P7-11, `src/rehearsal.ts`): `{ question }` (strict, 1 to 2000 characters after trimming) posts the question into the caller's own conversation with the bot and files it as a rehearsal question; answers 201 `{ botName, channelId, messageId }`. Only a lead of the team or a workspace admin (403 otherwise); 404 unknown bot; 409 for a bot that is not active, not `hermes`, without a `conversation` trigger, with `capabilities.runtime` granted, or with a test still running; 10 a minute per client. The run is a rehearsal: every write the bot tries is held back (see [bots](./bots.md)). |
| `GET /api/teams/:slug/bots/:botSlug/test/:messageId` | Where that test stands: `{ messageId, channelId, status, intercepted[], interceptedMore, knowledge }`. The asker's alone (404 for anyone else). |

The three lists:

- **Mine** — the caller's own conversations with this bot (any visibility), the root still alive.
- **Shared** — `visibility = 'shared'` rows the caller can read: their own and, through the copy, those of their team.
- **Channel mentions** — threads of a team channel where the caller **named the bot and it was asked to answer**: `bot_runs` of trigger
  `mention` whose asker is the caller, whose channel the caller can read, one per thread. Bots are not recorded in `message_mentions` (the
  channels plugin resolves `@handle` to people and channels only; the table's `bot` kind is unused), so the run the mention fired is the data;
  a mention of a bot that has no `mention` trigger fired nothing and is not listed. Runs are pruned by `retention` (default 90 days).

Each item carries the thread, the channel, who asked, `mine`, `visibility` (null for a mention), `title`, `preview` (the newest message),
`lastAuthor`, `lastActivityAt`, `replyCount`, `unreadCount` (the thread's read state), and for a shared conversation where it was posted.

### The empty state's chips

`prompts` come from the bot's own definition: the optional `conversation.prompts` list of `BOT.md` (strict: at most six strings of 1 to 200
characters; the JSON Schema and the schema-compat snapshot carry it; the bot page's Triggers tab edits it). The route reads
`bots/<slug>/BOT.md` at `main` through the repo provider and uses the list **only when the file is the one the roster row was loaded from** (the
same sha); anything else — no repo plugin, an unreadable or invalid file, a newer commit, no list — is the platform's defaults
(`DEFAULT_CONVERSATION_PROMPTS`) with `promptSource: 'default'`. A chip is sent as written when chosen.

## Events

| Type | Payload | When |
|---|---|---|
| `conversations.conversation.started` (v1) | `workspaceId, botId, personId, channelId, threadRootId` | once per conversation, when its root is indexed. Ids only, never text. **No `teamId`**: the stored `team_id` is what `events_select` lets every member of the team read, so a team-scoped event would tell a teammate that, and when, somebody talked to a bot in private. Without it the row is workspace-scoped (`team_id` null), as a DM's events are: only a workspace admin's policy reaches it. |
| `channel.channel.created` (existing) | `kind: 'bot_conversation'`, `private: true`, `name: ''`, `teamId: null` | when `open` makes the channel (as the person); no team, for the same reason. |

## Privacy

- Only the asker reads the channel, its members, its messages and its thread: a lead, a workspace admin and a second member of the team read
  nothing (`test/rls/conversations.test.ts`, `test/conversation.test.ts`).
- A conversation's **runs** are the asker's alone too: `bot_runs_select` (bots migration 0011) hides a run of the `conversation` trigger from
  everybody but its asker (and the run's own bot), and the bot page's run list filters it as well, so a teammate, the team's lead and a workspace
  admin do not learn who asked a bot what, when, in which thread or with what result (`bots/test/rls/bots.test.ts`, `bots/test/roster.test.ts`,
  `conversations/test/conversation.test.ts`). The lines a conversation run logged (`run_source_log`) follow the run. The system role (router,
  reaper, feed, retention, approvals) is unchanged. `bots.run.closed` still carries `teamId, botId, runId, trigger, status` (ids, no asker).
- The memory feed never reads a conversation: a message is fed only from a public channel of a team (`kind = 'channel'`), and a run whose trigger is
  `conversation` leaves no line (`memory` `test/feed.test.ts`, "a message of a conversation with a bot …").
- `person:*` connections are for `conversation` and `mention` runs only (the broker, unchanged).
- Search and the Threads inbox show a person their own conversations (a search hit or inbox row opens at `/t/:team/chat/:channelId?thread=`,
  which finds the bot from the channel).

## Sharing an answer (P5-17)

What a person does with an answer of their own conversation is this plugin's routes (the conversation index is its table, and a hand-off goes
through its `open` door); the masking rules and their SQL are the [answer](./answer.md#sharing-an-answer-p5-17) plugin's, and Save as page is the
[pages](./pages.md#save-as-page) plugin's route over the same view. Every route is addressed by the answer's own message in the caller's own
conversation channel and is a **404** for anybody else (an admin included).

| Method and path | What it does |
|---|---|
| `GET /api/channels/:channelId/messages/:messageId/answer/targets` | the team channels the caller may post in (not conversations, DMs or archived channels), at most 200 |
| `POST …/answer/preview` `{ target: { kind: 'channel', channelId } \| { kind: 'page' }, remove: number[] }` | the copy as it would be posted, items `kept` / `masked` / `removed`, `audience`, counts, `digest`. Writes nothing |
| `POST …/answer/share` `{ targetChannelId, remove, digest }` | 201 posts the masked copy as the sharer; 200 `replayed: true` for the same share; 409 when the copy would now differ from the digest; 403 for a channel the caller cannot post in; 400 for a DM or conversation target or a number the answer has no citation for; 422 when nothing would be left |
| `POST …/answer/handoff` `{ botId }` | 201 a thread in the caller's own conversation with that bot (200 `replayed`); only a bot the answer's chips name |

A share marks the conversation `shared` (the team lists it under **Shared**, read through the copy) **only for a channel of the bot's team that
is not private**; a copy in another team's channel or in a private room is posted and the conversation stays private. Deleting the copy un-marks it
(trigger `conversations_copy_deleted`), and the Shared list shows a row only while its copy is live and readable by the reader (so the "unreadable
copy" open item below is closed). The conversation's channel, thread and runs are never changed:
"the original conversation stays private" is a test (a teammate and an admin read nothing of it; the Shared list shows the copy).

**Events.** `answer.answer.shared` (v1) for each share (`kind` `channel` | `page` | `handoff`): ids, counts and the numbers of the masked and
removed citations; workspace-scoped, no `teamId`. This plugin emits it for `channel` and `handoff`; `channel.channel.created` is emitted when a
hand-off makes the person's conversation with the other bot. The log of a person's shares is `app.answer_shares` (the sharer reads their own).

**Web.** In the conversation view an answer that was for the reader shows **Share to channel** and **Save as page** under it, and its chips act
(a follow-up is sent into the same thread; "Hand to <bot>" opens that bot's conversation at the new thread). The dialog is the wireframe "Share
preview with masking": the channel picker (channels the person can post in), `[n] label · kept` and `[n] from Omar's Drive · not shared / snippet
removed [Remove claim on n]` rows (toggle buttons, `aria-pressed`), counts, Cancel and Share; focus is trapped, Escape closes, the classes are
`an-*` (answer.css), `data-vt-mask` on the sharer's own view of a masked label.

## Open items

- **`mentions` scan.** The Channel mentions list reads `bot_runs` by trigger `mention` and asker; a mention a bot never answered (no `mention` trigger,
  a run refused before it opened) is not listed, and a retention prune takes older ones out. A scan of `message_mentions` needs bots recorded there.
- **`bots.run.closed` and the audit tab.** The closing event of a conversation run is team-scoped (ids only) and so reveals that a conversation run
  ended, not whose; scoping it to the asker would change the memory feed's reader of it.

Share to #channel with masking, Save as page and Hand to a bot (P5-17) are below; the `Answer` (what a bot finishes a reply with: numbered sources, lineage, what it reached, what was out of scope, whom it was for) is the [answer](./answer.md) plugin's, P5-18. A conversation run sees only the message
it was started for (the thread's history reaches the bot through its tools, not the prompt); the reply is posted when the run ends (the
thread shows "<bot> is working on it…" for three minutes after the person's message). A bot's reply author is the generic "Bot" in the thread
(`app.message_authors`; naming bots is for the bots plugin).

## Manifest

`conversations` / `0.1.0` / `server`, `extends: ['event.subscribe', 'event.emit']`, emits `conversations.conversation.started`,
`channel.channel.created` and `answer.answer.shared`, consumes `channel.message.posted`, `dependsOn: ['channels', 'bots', 'answer']`, migrations
`migrations` (`0001` the door and the index, `0002` `app.conversations_mark_shared` and the trigger that clears the mark with the copy).

## Tests

`test/rls/conversations.test.ts` (`pnpm test:rls`: the door and its refusals, one channel per bot and person, the admin reads nothing, what a bot
sees in a run, the index policies and constraints), `test/conversation.test.ts` (the whole path through the real server with a stand-in Hermes:
open, send, the run's trigger and asker, the reply, the three lists, privacy, paging), `test/events/conversations-events.test.ts`
(`pnpm test:events`: no `team_id` on either event), `packages/plugins/runtime-hermes/test/router.test.ts` (the trigger rule), `packages/plugins/memory/test/feed.test.ts`
(a conversation is never fed), `e2e/conversations/conversation.spec.ts` (`pnpm e2e conversations`: the empty state and chips on both layouts,
send starts a thread and the reply appears, private by default, Shared, Channel mentions); `test/rehearsal.test.ts` (the Test action, P7-11: who may, the strict body, the run is a rehearsal for the asker, the note in the prompt, the result is the asker's alone), `test/share.test.ts` (sharing through the server: who may
touch an answer, preview, share, replay, masking per audience, removal, the event, Save as page, Hand to a bot), `test/rls/conversations.test.ts`
(`app.conversations_mark_shared`), `e2e/conversations/share.spec.ts` (desktop and mobile-web: share with a masked citation, remove a claim, save as
page, hand to a bot, follow-up).
